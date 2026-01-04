import { logger } from '@/config/logger';
import { redisConnection, isRedisAvailable } from '@/config/queue';
import { ExchangeRate, IExchangeRate } from '@/models/ExchangeRate';

interface ExchangeRates {
  [currency: string]: number;
}

// Supported currencies (base: INR)
const SUPPORTED_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'];

class CurrencyService {
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  private readonly API_URL = 'https://api.exchangerate-api.com/v4/latest/USD';
  private readonly REDIS_KEY_PREFIX = 'exchange_rates:';
  private readonly REDIS_CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds

  /**
   * Get today's date in YYYY-MM-DD format
   */
  private getTodayDateString(): string {
    const today = new Date();
    return today.toISOString().split('T')[0];
  }

  /**
   * Get exchange rates with caching strategy:
   * 1. Check Redis cache first
   * 2. If miss, check MongoDB
   * 3. If miss or stale, fetch from API
   * 4. Store in both MongoDB and Redis
   */
  async getExchangeRates(date?: Date): Promise<ExchangeRates> {
    const dateString = date ? date.toISOString().split('T')[0] : this.getTodayDateString();
    const redisKey = `${this.REDIS_KEY_PREFIX}${dateString}`;

    try {
      // Step 1: Try Redis cache first
      if (isRedisAvailable() && redisConnection) {
        try {
          const cached = await redisConnection.get(redisKey);
          if (cached) {
            const rates = JSON.parse(cached) as ExchangeRates;
            logger.debug({ date: dateString }, 'Using Redis cached exchange rates');
            return rates;
          }
        } catch (redisError: any) {
          logger.debug({ error: redisError.message }, 'Redis cache miss or error');
        }
      }

      // Step 2: Try MongoDB
      const dbRates = await ExchangeRate.findOne({ date: dateString }).exec();
      if (dbRates && dbRates.rates) {
        const rates: ExchangeRates = {};
        // Convert Map to object
        dbRates.rates.forEach((value: number, key: string) => {
          rates[key] = value;
        });

        // Cache in Redis for future use
        if (isRedisAvailable() && redisConnection) {
          try {
            await redisConnection.setex(redisKey, this.REDIS_CACHE_TTL, JSON.stringify(rates));
          } catch (redisError: any) {
            logger.debug({ error: redisError.message }, 'Failed to cache in Redis');
          }
        }

        logger.debug({ date: dateString }, 'Using MongoDB cached exchange rates');
        return rates;
      }

      // Step 3: Fetch from API (only for today's date)
      if (dateString === this.getTodayDateString()) {
        return await this.fetchAndStoreRates();
      } else {
        // For historical dates, return empty or throw error
        logger.warn({ date: dateString }, 'Historical exchange rates not available');
        return this.getDefaultRates();
      }
    } catch (error: any) {
      logger.error({ error: error.message, date: dateString }, 'Error getting exchange rates');
      return this.getDefaultRates();
    }
  }

  /**
   * Fetch exchange rates from API and store in MongoDB and Redis
   */
  async fetchAndStoreRates(): Promise<ExchangeRates> {
    try {
      logger.info('Fetching exchange rates from API');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(this.API_URL, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json() as { rates?: Record<string, number> };

      if (!data || !data.rates) {
        throw new Error('Invalid response from exchange rate API');
      }

      // Convert USD-based rates to INR-based rates
      // API returns rates like: { USD: 1, INR: 83.0, EUR: 0.92, ... }
      // We need: { USD: 0.012, EUR: 0.011, ... } (1/83.0, 0.92/83.0, ...)
      const usdToInr = data.rates.INR || 83.0;
      const inrBasedRates: ExchangeRates = {};

      // Calculate INR to other currencies
      for (const currency of SUPPORTED_CURRENCIES) {
        if (currency === 'INR') {
          inrBasedRates.INR = 1.0;
        } else if (data.rates[currency]) {
          // Convert: 1 INR = (1 / usdToInr) * (1 / usdToCurrency) = 1 / (usdToInr * usdToCurrency)
          // Actually: if 1 USD = X INR and 1 USD = Y Currency, then 1 INR = Y/X Currency
          inrBasedRates[currency] = data.rates[currency] / usdToInr;
        }
      }

      // Store in MongoDB
      const dateString = this.getTodayDateString();
      await ExchangeRate.findOneAndUpdate(
        { date: dateString },
        {
          base: 'INR',
          rates: inrBasedRates,
          date: dateString,
          lastUpdated: new Date(),
        },
        { upsert: true, new: true }
      );

      // Store in Redis
      if (isRedisAvailable() && redisConnection) {
        try {
          const redisKey = `${this.REDIS_KEY_PREFIX}${dateString}`;
          await redisConnection.setex(redisKey, this.REDIS_CACHE_TTL, JSON.stringify(inrBasedRates));
        } catch (redisError: any) {
          logger.debug({ error: redisError.message }, 'Failed to cache in Redis');
        }
      }

      logger.info({
        date: dateString,
        currencies: Object.keys(inrBasedRates),
      }, 'Exchange rates fetched and stored successfully');

      return inrBasedRates;
    } catch (error: any) {
      logger.error({
        error: error.message,
        url: this.API_URL,
      }, 'Error fetching exchange rates from API');

      // Try to return cached rates from MongoDB
      const dateString = this.getTodayDateString();
      const dbRates = await ExchangeRate.findOne({ date: dateString }).exec();
      if (dbRates && dbRates.rates) {
        const rates: ExchangeRates = {};
        dbRates.rates.forEach((value: number, key: string) => {
          rates[key] = value;
        });
        logger.warn('Using stale cached exchange rates due to API error');
        return rates;
      }

      // Final fallback to default rates
      logger.warn('Using default exchange rates due to API failure');
      return this.getDefaultRates();
    }
  }

  /**
   * Get default exchange rates (fallback)
   */
  private getDefaultRates(): ExchangeRates {
    // Default rates (approximate, should rarely be used)
    return {
      INR: 1.0,
      USD: 0.012, // 1 INR = 0.012 USD (approx 83 INR = 1 USD)
      EUR: 0.011,
      GBP: 0.0098,
      JPY: 1.8,
      CAD: 0.016,
      AUD: 0.018,
      CHF: 0.011,
    };
  }

  /**
   * Get exchange rates for a specific date
   */
  async getExchangeRatesForDate(date?: Date): Promise<ExchangeRates> {
    return this.getExchangeRates(date);
  }

  /**
   * Convert amount from source currency to target currency (default: INR)
   */
  async convertToINR(amount: number, sourceCurrency: string): Promise<number> {
    if (!amount || amount === 0) {
      return 0;
    }

    // If already in INR, return as is
    if (sourceCurrency.toUpperCase() === 'INR') {
      return amount;
    }

    try {
      const rates = await this.getExchangeRates();
      
      // If source currency is USD, use direct rate
      if (sourceCurrency.toUpperCase() === 'USD') {
        const inrRate = rates.INR || 83.0;
        return amount * inrRate;
      }

      // For other currencies, convert via USD
      // First convert source currency to USD, then USD to INR
      const usdRate = rates[sourceCurrency.toUpperCase()];
      if (!usdRate) {
        logger.warn(`Exchange rate not found for ${sourceCurrency}, assuming USD rate`);
        const inrRate = rates.INR || 83.0;
        return amount * inrRate;
      }

      // Convert: sourceCurrency -> USD -> INR
      const amountInUSD = amount / usdRate;
      const inrRate = rates.INR || 83.0;
      return amountInUSD * inrRate;
    } catch (error: any) {
      logger.error({
        amount,
        sourceCurrency,
        error: error.message,
      }, 'Error converting currency');
      
      // Fallback: assume it's USD if conversion fails
      if (sourceCurrency.toUpperCase() === 'USD') {
        return amount * 83.0; // Default fallback
      }
      
      // For other currencies, return amount as-is (shouldn't happen often)
      logger.warn(`Could not convert ${sourceCurrency}, returning original amount`);
      return amount;
    }
  }

  /**
   * Convert multiple amounts from various currencies to INR
   */
  async convertMultipleToINR(
    amounts: Array<{ amount: number; currency: string }>
  ): Promise<number> {
    const conversions = await Promise.all(
      amounts.map(({ amount, currency }) => this.convertToINR(amount, currency))
    );
    
    return conversions.reduce((sum, converted) => sum + converted, 0);
  }

  /**
   * Convert amount from INR to target currency
   */
  async convertFromINR(amount: number, targetCurrency: string): Promise<number> {
    if (!amount || amount === 0) {
      return 0;
    }

    // If target is INR, return as is
    if (targetCurrency.toUpperCase() === 'INR') {
      return amount;
    }

    try {
      const rates = await this.getExchangeRates();
      const rate = rates[targetCurrency.toUpperCase()];

      if (!rate) {
        logger.warn(`Exchange rate not found for ${targetCurrency}, returning original amount`);
        return amount;
      }

      return amount * rate;
    } catch (error: any) {
      logger.error({
        amount,
        targetCurrency,
        error: error.message,
      }, 'Error converting from INR');
      return amount;
    }
  }

  /**
   * Get current USD to INR rate (for backward compatibility)
   */
  async getUSDtoINRRate(): Promise<number> {
    const rates = await this.getExchangeRates();
    // If rates have USD, calculate: 1 USD = 1 / rates.USD INR
    if (rates.USD) {
      return 1 / rates.USD;
    }
    return 83.0; // Default fallback
  }

  /**
   * Get supported currencies
   */
  getSupportedCurrencies(): string[] {
    return [...SUPPORTED_CURRENCIES];
  }
}

export const currencyService = new CurrencyService();


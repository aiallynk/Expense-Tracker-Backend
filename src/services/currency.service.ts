import { logger } from '@/config/logger';
import { redisConnection, isRedisAvailable } from '@/config/queue';
import { ExchangeRate } from '@/models/ExchangeRate';

interface ExchangeRates {
  [currency: string]: number;
}

// Supported currencies (base: INR)
const SUPPORTED_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'];

class CurrencyService {
  private readonly API_URL = 'https://api.exchangerate-api.com/v4/latest/USD';
  /** Free historical rates (base EUR); used for past dates */
  private readonly HISTORICAL_API_URL = 'https://api.frankfurter.app';
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
        // Convert Map to object - handle both Map instance and plain object
        if (dbRates.rates instanceof Map) {
          dbRates.rates.forEach((value: number, key: string) => {
            rates[key] = value;
          });
        } else {
          // If it's already a plain object, use it directly
          Object.assign(rates, dbRates.rates);
        }

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

      // Step 3: Fetch from API
      if (dateString === this.getTodayDateString()) {
        return await this.fetchAndStoreRates();
      }
      // For historical dates, try Frankfurter (free, date-wise)
      const historical = await this.fetchHistoricalRates(dateString);
      if (historical && Object.keys(historical).length > 0) {
        return historical;
      }
      logger.warn({ date: dateString }, 'Historical exchange rates not available, using default');
      return this.getDefaultRates();
    } catch (error: any) {
      logger.error({ error: error.message, date: dateString }, 'Error getting exchange rates');
      return this.getDefaultRates();
    }
  }

  /**
   * Fetch historical exchange rates for a given date (free API: Frankfurter).
   * Returns INR-based rates: 1 INR = X Currency for each currency.
   */
  async fetchHistoricalRates(dateString: string): Promise<ExchangeRates | null> {
    try {
      const toList = SUPPORTED_CURRENCIES.join(',');
      const url = `${this.HISTORICAL_API_URL}/${dateString}?from=EUR&to=${toList}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) return null;
      const data = await response.json() as { rates?: Record<string, number> };
      if (!data?.rates?.INR) return null;
      const rates = data.rates;
      const inrBasedRates: ExchangeRates = { INR: 1 };
      for (const currency of SUPPORTED_CURRENCIES) {
        if (currency === 'INR') continue;
        if (currency === 'EUR') {
          inrBasedRates.EUR = 1 / rates.INR;
        } else if (rates[currency] != null) {
          inrBasedRates[currency] = rates[currency] / rates.INR;
        }
      }
      if (Object.keys(inrBasedRates).length <= 1) return null;
      await ExchangeRate.findOneAndUpdate(
        { date: dateString },
        { base: 'INR', rates: inrBasedRates, date: dateString, lastUpdated: new Date() },
        { upsert: true, new: true }
      );
      if (isRedisAvailable() && redisConnection) {
        try {
          await redisConnection.setex(`${this.REDIS_KEY_PREFIX}${dateString}`, this.REDIS_CACHE_TTL, JSON.stringify(inrBasedRates));
        } catch (_) {}
      }
      logger.debug({ date: dateString }, 'Historical exchange rates fetched');
      return inrBasedRates;
    } catch (error: any) {
      logger.debug({ dateString, error: error.message }, 'Historical rates fetch failed');
      return null;
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
        // Convert Map to object - handle both Map instance and plain object
        if (dbRates.rates instanceof Map) {
          dbRates.rates.forEach((value: number, key: string) => {
            rates[key] = value;
          });
        } else {
          // If it's already a plain object, use it directly
          Object.assign(rates, dbRates.rates);
        }
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
   * Convert amount from one currency to another
   * Returns conversion details including rate and date.
   * When rateDate is provided, uses exchange rates for that date (date-wise accurate).
   * @param amount - Original amount
   * @param fromCurrency - Source currency
   * @param toCurrency - Target currency
   * @param rateDate - Optional date for exchange rate (e.g. invoice date); uses today if omitted
   */
  async convertCurrency(
    amount: number,
    fromCurrency: string,
    toCurrency: string,
    rateDate?: Date
  ): Promise<{
    convertedAmount: number;
    rate: number;
    rateDate: Date;
  }> {
    if (!amount || amount === 0) {
      return {
        convertedAmount: 0,
        rate: 1,
        rateDate: rateDate || new Date(),
      };
    }

    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    if (from === to) {
      return {
        convertedAmount: amount,
        rate: 1,
        rateDate: rateDate || new Date(),
      };
    }

    try {
      const rates = await this.getExchangeRates(rateDate);
      const rateDateRes = rateDate || new Date();
      
      // Log for debugging
      logger.debug({
        from,
        to,
        amount,
        availableRates: Object.keys(rates),
      }, 'Converting currency');

      let rate = 1;
      let convertedAmount = amount;

      if (from === 'INR') {
        // From INR to target
        // rates[to] means: 1 INR = rates[to] * targetCurrency
        const toRate = rates[to];
        if (!toRate || toRate <= 0) {
          logger.error(`Exchange rate not found for ${to}. Available rates: ${Object.keys(rates).join(', ')}`);
          throw new Error(`Exchange rate not found for ${to}`);
        }
        rate = toRate;
        convertedAmount = amount * toRate;
      } else if (to === 'INR') {
        // From source to INR
        // rates[from] means: 1 INR = rates[from] * sourceCurrency
        // So: 1 sourceCurrency = 1 / rates[from] INR
        const fromRate = rates[from];
        if (!fromRate || fromRate <= 0) {
          logger.error(`Exchange rate not found for ${from}. Available rates: ${Object.keys(rates).join(', ')}`);
          throw new Error(`Exchange rate not found for ${from}`);
        }
        // If 1 INR = X Currency, then 1 Currency = 1/X INR
        rate = 1 / fromRate;
        convertedAmount = amount / fromRate;
      } else {
        // From source to target via INR
        // Both are non-INR currencies
        const fromRate = rates[from];
        const toRate = rates[to];
        
        if (!fromRate || fromRate <= 0) {
          logger.error(`Exchange rate not found for ${from}. Available rates: ${Object.keys(rates).join(', ')}`);
          throw new Error(`Exchange rate not found for ${from}`);
        }
        if (!toRate || toRate <= 0) {
          logger.error(`Exchange rate not found for ${to}. Available rates: ${Object.keys(rates).join(', ')}`);
          throw new Error(`Exchange rate not found for ${to}`);
        }
        
        // Convert: fromCurrency -> INR -> toCurrency
        // Step 1: fromCurrency to INR: amount / fromRate
        // Step 2: INR to toCurrency: (amount / fromRate) * toRate
        rate = toRate / fromRate;
        convertedAmount = (amount / fromRate) * toRate;
      }

      logger.info({
        from,
        to,
        originalAmount: amount,
        convertedAmount,
        rate,
      }, 'Currency conversion successful');

      return {
        convertedAmount: Math.round(convertedAmount * 100) / 100, // Round to 2 decimals
        rate: Math.round(rate * 10000) / 10000, // Round to 4 decimals
        rateDate: rateDateRes,
      };
    } catch (error: any) {
      logger.error({
        amount,
        fromCurrency,
        toCurrency,
        error: error.message,
        stack: error.stack,
      }, 'Error converting currency');
      // Re-throw to let caller handle it properly
      throw new Error(`Currency conversion failed: ${error.message}`);
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


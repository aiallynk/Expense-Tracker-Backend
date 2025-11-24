import { logger } from '@/config/logger';

interface ExchangeRates {
  [currency: string]: number;
}

class CurrencyService {
  private exchangeRates: ExchangeRates = {};
  private lastFetchTime: number = 0;
  private readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds
  private readonly API_URL = 'https://api.exchangerate-api.com/v4/latest/USD';

  /**
   * Get exchange rate from USD to target currency
   * Uses cached rates if available and fresh
   */
  private async getExchangeRates(): Promise<ExchangeRates> {
    const now = Date.now();
    
    // Return cached rates if still fresh
    if (this.exchangeRates.INR && (now - this.lastFetchTime) < this.CACHE_DURATION) {
      logger.debug({ 
        INR: this.exchangeRates.INR,
        cacheAge: Math.round((now - this.lastFetchTime) / 1000 / 60) + ' minutes'
      }, 'Using cached exchange rates');
      return this.exchangeRates;
    }

    try {
      logger.info('Fetching real-time exchange rates');
      
      // Use native fetch with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(this.API_URL, {
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json() as { rates?: Record<string, number> };

      if (data && data.rates) {
        this.exchangeRates = data.rates;
        this.lastFetchTime = now;
        
        logger.info({
          INR: this.exchangeRates.INR,
          timestamp: new Date(now).toISOString(),
        }, 'Exchange rates fetched successfully');
        
        return this.exchangeRates;
      } else {
        throw new Error('Invalid response from exchange rate API');
      }
    } catch (error: any) {
      logger.error({
        error: error.message,
        url: this.API_URL,
      }, 'Error fetching exchange rates');

      // Fallback to cached rates if available, otherwise use default
      if (this.exchangeRates.INR) {
        logger.warn('Using stale cached exchange rates due to API error');
        return this.exchangeRates;
      }

      // Fallback to a default rate if API fails and no cache exists
      logger.warn('Using default exchange rate (83.0) due to API failure');
      return { INR: 83.0 }; // Default fallback rate
    }
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
   * Get current USD to INR rate
   */
  async getUSDtoINRRate(): Promise<number> {
    const rates = await this.getExchangeRates();
    return rates.INR || 83.0;
  }
}

export const currencyService = new CurrencyService();


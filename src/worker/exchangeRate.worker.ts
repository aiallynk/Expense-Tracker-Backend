import cron from 'node-cron';
import { logger } from '@/config/logger';
import { currencyService } from '@/services/currency.service';

/**
 * Daily exchange rate fetch worker
 * Runs at 2:00 AM UTC daily to fetch and store exchange rates
 */
export const startExchangeRateWorker = (): void => {
  // Schedule: Run daily at 2:00 AM UTC
  // Format: minute hour day month dayOfWeek
  // '0 2 * * *' = At 02:00 UTC every day
  const cronSchedule = process.env.EXCHANGE_RATE_CRON_SCHEDULE || '0 2 * * *';

  logger.info({ schedule: cronSchedule }, 'Starting exchange rate worker');

  cron.schedule(cronSchedule, async () => {
    try {
      logger.info('Exchange rate worker: Starting daily rate fetch');
      
      await currencyService.fetchAndStoreRates();
      
      logger.info('Exchange rate worker: Successfully fetched and stored exchange rates');
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
        },
        'Exchange rate worker: Failed to fetch exchange rates'
      );
    }
  });

  // Also fetch rates immediately on startup (if not already cached)
  // This ensures rates are available even if the server starts after 2 AM
  (async () => {
    try {
      logger.info('Exchange rate worker: Checking for initial rates');
      const rates = await currencyService.getExchangeRates();
      if (rates && Object.keys(rates).length > 0) {
        logger.info('Exchange rate worker: Initial rates available');
      } else {
        logger.info('Exchange rate worker: Fetching initial rates');
        await currencyService.fetchAndStoreRates();
      }
    } catch (error: any) {
      logger.warn(
        { error: error.message },
        'Exchange rate worker: Failed to fetch initial rates, will retry on schedule'
      );
    }
  })();
};


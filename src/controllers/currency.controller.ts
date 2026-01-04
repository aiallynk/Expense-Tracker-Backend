import { Request, Response } from 'express';
import { logger } from '@/config/logger';
import { currencyService } from '@/services/currency.service';

export class CurrencyController {
  /**
   * GET /api/v1/currency/rates
   * Get current exchange rates
   */
  static async getRates(req: Request, res: Response): Promise<void> {
    try {
      const dateParam = req.query.date as string | undefined;
      const date = dateParam ? new Date(dateParam) : undefined;

      const rates = await currencyService.getExchangeRates(date);
      const supportedCurrencies = currencyService.getSupportedCurrencies();

      res.json({
        success: true,
        data: {
          base: 'INR',
          rates,
          supportedCurrencies,
          lastUpdated: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error getting exchange rates');
      res.status(500).json({
        success: false,
        message: 'Failed to get exchange rates',
        error: error.message,
      });
    }
  }

  /**
   * GET /api/v1/currency/convert
   * Convert amount from one currency to another
   * Query params: amount, from, to
   */
  static async convert(req: Request, res: Response): Promise<void> {
    try {
      const amount = parseFloat(req.query.amount as string);
      const from = (req.query.from as string) || 'INR';
      const to = (req.query.to as string) || 'INR';

      if (isNaN(amount) || amount < 0) {
        res.status(400).json({
          success: false,
          message: 'Invalid amount',
        });
        return;
      }

      if (!from || !to) {
        res.status(400).json({
          success: false,
          message: 'Missing currency parameters (from/to)',
        });
        return;
      }

      let convertedAmount: number;

      if (from.toUpperCase() === 'INR') {
        // Convert from INR to target currency
        convertedAmount = await currencyService.convertFromINR(amount, to);
      } else if (to.toUpperCase() === 'INR') {
        // Convert from source currency to INR
        convertedAmount = await currencyService.convertToINR(amount, from);
      } else {
        // Convert via INR: from -> INR -> to
        const inrAmount = await currencyService.convertToINR(amount, from);
        convertedAmount = await currencyService.convertFromINR(inrAmount, to);
      }

      res.json({
        success: true,
        data: {
          amount,
          from: from.toUpperCase(),
          to: to.toUpperCase(),
          convertedAmount: Math.round(convertedAmount * 100) / 100, // Round to 2 decimal places
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error converting currency');
      res.status(500).json({
        success: false,
        message: 'Failed to convert currency',
        error: error.message,
      });
    }
  }

  /**
   * GET /api/v1/currency/supported
   * Get list of supported currencies
   */
  static async getSupportedCurrencies(_req: Request, res: Response): Promise<void> {
    try {
      const currencies = currencyService.getSupportedCurrencies();

      res.json({
        success: true,
        data: {
          currencies,
          base: 'INR',
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error getting supported currencies');
      res.status(500).json({
        success: false,
        message: 'Failed to get supported currencies',
        error: error.message,
      });
    }
  }
}


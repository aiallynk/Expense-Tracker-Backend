import { Router } from 'express';

import { CurrencyController } from '@/controllers/currency.controller';
import { authMiddleware } from '@/middleware/auth.middleware';

const router = Router();

/**
 * Currency routes
 * Public routes (no auth required)
 */
router.get('/rates', CurrencyController.getRates);
router.get('/supported', CurrencyController.getSupportedCurrencies);

/**
 * Protected routes (require authentication)
 */
router.use('/convert', authMiddleware);
router.get('/convert', CurrencyController.convert);

export default router;


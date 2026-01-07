import { Router } from 'express';

import { CurrencyController } from '@/controllers/currency.controller';
import { authMiddleware } from '@/middleware/auth.middleware';

const router = Router();

/**
 * Currency routes
 * All routes require authentication
 */
router.use(authMiddleware);

router.get('/rates', CurrencyController.getRates);
router.get('/convert', CurrencyController.convert);
router.get('/supported', CurrencyController.getSupportedCurrencies);

export default router;


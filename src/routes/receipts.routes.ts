import { Router } from 'express';
import express from 'express';

import { ReceiptsController } from '../controllers/receipts.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { receiptUploadRateLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import { uploadIntentSchema } from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.post(
  '/expenses/:expenseId/receipts/upload-intent',
  receiptUploadRateLimiter,
  validate(uploadIntentSchema),
  ReceiptsController.createUploadIntent
);

router.post(
  '/receipts/:receiptId/confirm',
  receiptUploadRateLimiter,
  ReceiptsController.confirmUpload
);

router.get('/receipts/:id', ReceiptsController.getById);

// Upload file via backend (bypasses CORS)
// Use raw body parser for binary file uploads
router.post(
  '/receipts/:receiptId/upload',
  receiptUploadRateLimiter,
  express.raw({ type: '*/*', limit: '10mb' }),
  ReceiptsController.uploadFile
);

export default router;


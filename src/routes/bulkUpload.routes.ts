import { Router } from 'express';

import { BulkUploadController } from '../controllers/bulkUpload.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { bulkUploadRateLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import { bulkDocumentUploadIntentSchema, bulkDocumentConfirmSchema } from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * POST /bulk-upload/intent
 * Create upload intent for bulk document (PDF, Excel, images with multiple receipts)
 */
router.post(
  '/bulk-upload/intent',
  bulkUploadRateLimiter,
  validate(bulkDocumentUploadIntentSchema),
  BulkUploadController.createUploadIntent
);

/**
 * POST /bulk-upload/confirm
 * Confirm upload and process document for multi-receipt extraction
 */
router.post(
  '/bulk-upload/confirm',
  bulkUploadRateLimiter,
  validate(bulkDocumentConfirmSchema),
  BulkUploadController.confirmUpload
);

/**
 * GET /bulk-upload/supported-types
 * Get list of supported file types for bulk upload
 */
router.get(
  '/bulk-upload/supported-types',
  BulkUploadController.getSupportedTypes
);

export default router;


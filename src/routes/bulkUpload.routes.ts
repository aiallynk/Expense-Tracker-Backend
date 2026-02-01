import { Router } from 'express';

import { BulkUploadController } from '../controllers/bulkUpload.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { bulkUploadRateLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  bulkDocumentUploadIntentSchema,
  bulkDocumentConfirmSchema,
  batchUploadIntentSchema,
  batchUploadConfirmSchema,
} from '../utils/dtoTypes';

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
 * POST /bulk-upload/batch-intent
 * Batch-first: create all receipts for a batch, return presigned URLs. One call for entire batch.
 */
router.post(
  '/bulk-upload/batch-intent',
  bulkUploadRateLimiter,
  validate(batchUploadIntentSchema),
  BulkUploadController.createBatchIntent
);

/**
 * POST /bulk-upload/batch-confirm
 * Batch-first: confirm all receipts, create expense drafts, enqueue all OCR jobs. Respond once.
 */
router.post(
  '/bulk-upload/batch-confirm',
  bulkUploadRateLimiter,
  validate(batchUploadConfirmSchema),
  BulkUploadController.confirmBatch
);

/**
 * GET /bulk-upload/batch/:batchId/status
 * Get batch progress (totalReceipts, completedReceipts, failedReceipts, status).
 */
router.get(
  '/bulk-upload/batch/:batchId/status',
  bulkUploadRateLimiter,
  BulkUploadController.getBatchStatus
);

/**
 * POST /bulk-upload/batch/:batchId/retry-failed
 * Re-enqueue OCR for failed receipts in the batch only.
 */
router.post(
  '/bulk-upload/batch/:batchId/retry-failed',
  bulkUploadRateLimiter,
  BulkUploadController.retryFailedReceipts
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


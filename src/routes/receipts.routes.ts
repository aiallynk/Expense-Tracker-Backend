import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { ReceiptsController } from '../controllers/receipts.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import {
  receiptUploadRateLimiter,
  receiptUploadPerMinuteRateLimiter,
  receiptUploadPerMinutePerCompanyRateLimiter,
} from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import { uploadIntentSchema } from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.post(
  '/expenses/:expenseId/receipts/upload-intent',
  receiptUploadPerMinuteRateLimiter,
  receiptUploadPerMinutePerCompanyRateLimiter,
  receiptUploadRateLimiter,
  validate(uploadIntentSchema),
  ReceiptsController.createUploadIntent
);

router.post(
  '/receipts/:receiptId/confirm',
  receiptUploadPerMinuteRateLimiter,
  receiptUploadPerMinutePerCompanyRateLimiter,
  receiptUploadRateLimiter,
  ReceiptsController.confirmUpload
);

router.get('/receipts/:id', ReceiptsController.getById);

// Upload file via backend (bypasses CORS)
// Use multer with diskStorage to avoid loading entire file into memory
const uploadDir = path.join(os.tmpdir(), 'receipt-uploads');
// Ensure temp directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, _file, cb) => {
    // Generate unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `receipt-${uniqueSuffix}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req, _file, cb) => {
    // Accept all file types for receipts (images, PDFs, etc.)
    cb(null, true);
  },
});

router.post(
  '/receipts/:receiptId/upload',
  receiptUploadPerMinuteRateLimiter,
  receiptUploadPerMinutePerCompanyRateLimiter,
  receiptUploadRateLimiter,
  upload.single('file'),
  ReceiptsController.uploadFile
);

export default router;


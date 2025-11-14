import { Router } from 'express';
import { OcrController } from '../controllers/ocr.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { ocrRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);
router.use(ocrRateLimiter);

router.get('/jobs/:id', OcrController.getJobStatus);

export default router;


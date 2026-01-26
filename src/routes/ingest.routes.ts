import { Router } from 'express';

import { IngestController } from '../controllers/ingest.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { apiRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Apply rate limiting (use general API rate limiter)
router.use(apiRateLimiter);

// POST /api/v1/ingest/:sessionId - Forward debug logging to local ingest service
router.post('/:sessionId', IngestController.ingest);

export default router;

import { Router } from 'express';
import { MetaController } from '@/controllers/meta.controller';

const router = Router();

/**
 * GET /api/meta/version
 * Get application version information
 * Public endpoint - no authentication required
 */
router.get('/version', MetaController.getVersion);

export default router;

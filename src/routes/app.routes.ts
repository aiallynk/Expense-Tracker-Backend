import { Router } from 'express';
import { AppController } from '@/controllers/app.controller';

const router = Router();

/**
 * GET /api/app/version
 * Get app update info for in-app APK update prompts (non-Play Store distribution)
 * Public endpoint - no authentication required
 * Query: currentVersion (optional) - client's app version for forceUpdate computation
 */
router.get('/version', AppController.getVersion);

/**
 * GET /api/app/apk/:version
 * Serve APK file as raw binary with correct headers.
 * Public endpoint - no authentication required.
 */
router.get('/apk/:version', AppController.serveApk);

export default router;

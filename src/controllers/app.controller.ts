import { Request, Response } from 'express';
import { appUpdateService } from '@/services/app-update.service';
import { logger } from '@/config/logger';

/**
 * GET /api/app/version
 * Returns app update info for in-app APK update prompts.
 * Public endpoint - no authentication required.
 *
 * Query params:
 * - currentVersion (optional): Client's app version. If provided, backend computes forceUpdate.
 */
export class AppController {
  static async getVersion(req: Request, res: Response): Promise<void> {
    try {
      const currentVersion = (req.query.currentVersion as string) || undefined;
      const info = appUpdateService.getAppVersionInfo(currentVersion);

      res.status(200).json({
        success: true,
        data: info,
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error getting app version info');
      res.status(500).json({
        success: false,
        message: 'Failed to get app version information',
        error: error.message,
      });
    }
  }
}

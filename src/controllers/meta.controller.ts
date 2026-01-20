import { Request, Response } from 'express';
import { versionService } from '@/services/version.service';
import { logger } from '@/config/logger';

export class MetaController {
  /**
   * GET /api/meta/version
   * Get application version information
   * Public endpoint - no authentication required
   */
  static async getVersion(_req: Request, res: Response): Promise<void> {
    try {
      const versionData = versionService.getVersion();

      res.status(200).json({
        success: true,
        data: {
          webVersion: versionData.web,
          appVersion: versionData.app,
          build: versionData.build,
          lastUpdated: versionData.lastUpdated,
        },
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error getting version information');
      res.status(500).json({
        success: false,
        message: 'Failed to get version information',
        error: error.message,
      });
    }
  }
}

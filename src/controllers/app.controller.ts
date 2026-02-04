import fs from 'fs';
import path from 'path';
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

  /**
   * GET /api/app/apk/:version
   * Serves APK file as raw binary with correct headers.
   * Validates version matches latestVersion from app-update.json.
   */
  static async serveApk(req: Request, res: Response): Promise<void> {
    try {
      const requestedVersion = (req.params.version || '').trim();
      const configData = appUpdateService.getConfig();

      if (requestedVersion !== configData.latestVersion) {
        res.status(404).json({
          success: false,
          message: `APK version ${requestedVersion} not found`,
        });
        return;
      }

      const apkDir = path.join(process.cwd(), 'apk');
      const filename = `nexpense_v${requestedVersion}.apk`;
      const filePath = path.join(apkDir, filename);

      if (!fs.existsSync(filePath)) {
        logger.warn({ filePath, version: requestedVersion }, 'APK file not found');
        res.status(404).json({
          success: false,
          message: 'APK file not available',
        });
        return;
      }

      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.sendFile(path.resolve(filePath));
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error serving APK');
      res.status(500).json({
        success: false,
        message: 'Failed to serve APK',
        error: error.message,
      });
    }
  }
}

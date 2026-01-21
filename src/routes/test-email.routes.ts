import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/error.middleware';
import { NotificationService } from '../services/notification.service';
import { getResendClient, getFromEmail } from '../config/resend';
import { config } from '../config/index';
import { logger } from '../config/logger';

const router = Router();

/**
 * Test endpoint to check email configuration and send a test email
 * POST /api/v1/test-email
 * Body: { to: string }
 */
router.post(
  '/test-email',
  asyncHandler(async (req: Request, res: Response) => {
    const { to } = req.body;

    if (!to) {
      res.status(400).json({
        success: false,
        message: 'Email address (to) is required',
      });
      return;
    }

    // Check configuration
    const apiKeyConfigured = !!config.resend.apiKey;
    const fromEmail = getFromEmail();
    const client = getResendClient();

    const configStatus = {
      apiKeyConfigured,
      apiKeyLength: config.resend.apiKey ? config.resend.apiKey.length : 0,
      fromEmail,
      clientInitialized: !!client,
    };

    logger.info({ configStatus, to }, 'Test email request received');

    if (!client) {
      res.status(500).json({
        success: false,
        message: 'Resend client not initialized. Check RESEND_API_KEY configuration.',
        config: configStatus,
      });
      return;
    }

    try {
      // Send test email
      await NotificationService.sendEmail({
        to,
        subject: 'Test Email - NexPense',
        template: 'password_reset',
        data: {
          resetLink: `${config.frontend.url}/reset-password?token=test-token-123`,
          token: 'test-token-123',
        },
      });

      res.status(200).json({
        success: true,
        message: 'Test email sent successfully',
        config: configStatus,
      });
    } catch (error: any) {
      logger.error({ error, to }, 'Failed to send test email');
      res.status(500).json({
        success: false,
        message: 'Failed to send test email',
        error: error.message || error,
        config: configStatus,
      });
    }
  })
);

export default router;

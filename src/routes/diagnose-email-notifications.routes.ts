import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/error.middleware';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { getResendClient, getFromEmail } from '../config/resend';
import { getMessaging } from '../config/firebase';
import { NotificationToken } from '../models/NotificationToken';
import { User } from '../models/User';
import { config } from '../config';
import { UserRole } from '../utils/enums';

const router = Router();

/**
 * Diagnostic endpoint to check email and notification configuration
 * Only accessible to admins
 */
router.get(
  '/diagnose',
  authMiddleware,
  requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  asyncHandler(async (_req: Request, res: Response) => {
    const diagnostics: any = {
      timestamp: new Date().toISOString(),
      email: {
        configured: false,
        issues: [],
        config: {},
      },
      notifications: {
        configured: false,
        issues: [],
        stats: {},
      },
    };

    // Check email configuration
    const resendClient = getResendClient();
    const fromEmail = getFromEmail();
    
    diagnostics.email.config = {
      hasApiKey: !!config.resend.apiKey,
      apiKeyLength: config.resend.apiKey ? config.resend.apiKey.length : 0,
      fromEmail: fromEmail,
      clientInitialized: !!resendClient,
      envVars: {
        RESEND_API_KEY: process.env.RESEND_API_KEY ? 'SET' : 'NOT SET',
        RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL || 'NOT SET',
        MAIL_FROM: process.env.MAIL_FROM || 'NOT SET',
      },
    };

    if (!config.resend.apiKey) {
      diagnostics.email.issues.push('RESEND_API_KEY environment variable is not set');
    } else if (!resendClient) {
      diagnostics.email.issues.push('Resend client failed to initialize (check API key validity)');
    } else {
      diagnostics.email.configured = true;
    }

    if (!fromEmail || fromEmail.includes('no-reply@nexpense.aially.in')) {
      diagnostics.email.issues.push('RESEND_FROM_EMAIL not properly configured - using default');
    }

    // Check notification configuration
    const messaging = getMessaging();
    
    diagnostics.notifications.config = {
      firebaseConfigured: !!messaging,
      hasServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    };

    if (!messaging) {
      diagnostics.notifications.issues.push('Firebase Cloud Messaging not configured - push notifications will not work');
    } else {
      diagnostics.notifications.configured = true;
    }

    // Get notification token statistics
    try {
      const totalTokens = await NotificationToken.countDocuments();
      const usersWithTokens = await NotificationToken.distinct('userId');
      const totalUsers = await User.countDocuments({ status: 'ACTIVE' });
      
      diagnostics.notifications.stats = {
        totalTokens,
        usersWithTokens: usersWithTokens.length,
        totalActiveUsers: totalUsers,
        coveragePercentage: totalUsers > 0 ? ((usersWithTokens.length / totalUsers) * 100).toFixed(2) : 0,
      };

      if (usersWithTokens.length === 0) {
        diagnostics.notifications.issues.push('No users have registered FCM tokens - push notifications will not be delivered');
      } else if (usersWithTokens.length < totalUsers * 0.5) {
        diagnostics.notifications.issues.push(`Only ${usersWithTokens.length} out of ${totalUsers} users have registered FCM tokens`);
      }
    } catch (error: any) {
      diagnostics.notifications.issues.push(`Error checking notification stats: ${error.message}`);
    }

    res.status(200).json({
      success: true,
      diagnostics,
      recommendations: [
        ...(diagnostics.email.issues.length > 0 ? [
          '1. Set RESEND_API_KEY environment variable with a valid Resend API key',
          '2. Set RESEND_FROM_EMAIL to a verified domain email address',
          '3. Verify the domain in Resend dashboard',
        ] : []),
        ...(diagnostics.notifications.issues.length > 0 ? [
          '1. Ensure Firebase Cloud Messaging is properly configured',
          '2. Users need to open the app and allow notifications to register FCM tokens',
          '3. Check that FIREBASE_SERVICE_ACCOUNT environment variable is set',
        ] : []),
      ],
    });
  })
);

export default router;

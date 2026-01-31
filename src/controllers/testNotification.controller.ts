import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { NotificationType } from '../models/Notification';
import { NotificationToken } from '../models/NotificationToken';
import { User } from '../models/User';
import { NotificationService } from '../services/notification.service';
import { NotificationDataService } from '../services/notificationData.service';
import { emitNotificationToUser } from '../socket/realtimeEvents';

import { logger } from '@/config/logger';

export class TestNotificationController {
  /**
   * Send test notification to all users with FCM tokens
   * SUPER_ADMIN only
   */
  static sendTestNotification = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { title, body } = req.body;

      if (!title || !body) {
        res.status(400).json({
          success: false,
          message: 'Title and body are required',
        });
        return;
      }

      // Fetch all users with FCM tokens
      const tokens = await NotificationToken.find({ fcmToken: { $exists: true, $ne: null } })
        .select('userId')
        .exec();

      if (tokens.length === 0) {
        res.status(200).json({
          success: true,
          message: 'No users with FCM tokens found',
          data: {
            totalUsers: 0,
            notificationsCreated: 0,
            pushNotificationsSent: { successCount: 0, failureCount: 0 },
          },
        });
        return;
      }

      // Get unique user IDs
      const userIds = Array.from(new Set(tokens.map((t: any) => t.userId.toString())));

      // Send push notification to all users
      const pushResult = await NotificationService.sendPushToAllUsers({
        title,
        body,
        data: {
          type: 'TEST_NOTIFICATION',
          action: 'test',
        },
      });

      // Create notification records for each user
      const notifications = [];
      let notificationsCreated = 0;

      for (const userId of userIds) {
        try {
          const user = await User.findById(userId).select('companyId').exec();
          if (!user) {
            logger.warn(`User ${userId} not found, skipping notification creation`);
            continue;
          }

          const notification = await NotificationDataService.createNotification({
            userId,
            companyId: user.companyId?.toString(),
            type: NotificationType.TEST_NOTIFICATION,
            title,
            description: body,
            metadata: {
              testNotification: true,
            },
          });

          if (notification) {
            notifications.push(notification);

            // Emit real-time event to user
            emitNotificationToUser(userId, notification.toObject());

            notificationsCreated++;
          }

        } catch (error: any) {
          logger.error({ error: error.message || error, userId }, 'Error creating notification for user');
        }
      }

      // Note: Socket.IO is only for UI refresh, not for delivery
      // Firebase FCM is the primary delivery mechanism (already sent above)

      logger.info(`Test notification sent: ${notificationsCreated} notifications created, ${pushResult.successCount} push notifications sent`);

      res.status(200).json({
        success: true,
        message: 'Test notification sent successfully',
        data: {
          totalUsers: userIds.length,
          notificationsCreated,
          pushNotificationsSent: {
            successCount: pushResult.successCount,
            failureCount: pushResult.failureCount,
          },
        },
      });
    } catch (error: any) {
      throw error;
    }
  });
}


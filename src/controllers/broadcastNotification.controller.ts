import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { NotificationService } from '../services/notification.service';
import { NotificationDataService } from '../services/notificationData.service';
import { BroadcastTargetType } from '../utils/enums';
import { getAllUsersTopic, getCompanyTopic, getRoleTopic } from '../utils/topicUtils';
import { emitNotificationToAll, emitToCompanyAdmin, CompanyAdminEvent, emitNotificationToUser } from '../socket/realtimeEvents';

import { logger } from '@/config/logger';

export class BroadcastNotificationController {
  /**
   * Send broadcast notification using FCM Topics
   * SUPER_ADMIN only
   * Scalable - sends ONE message to topic instead of looping users
   */
  static sendBroadcastNotification = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
    const { title, body, targetType, companyId, role } = req.body;
    const createdBy = req.user!.id;

    // Validate required fields
    if (!title || !body) {
      res.status(400).json({
        success: false,
        message: 'Title and body are required',
      });
      return;
    }

    if (!targetType || !Object.values(BroadcastTargetType).includes(targetType)) {
      res.status(400).json({
        success: false,
        message: `targetType must be one of: ${Object.values(BroadcastTargetType).join(', ')}`,
      });
      return;
    }

    // Validate targetType-specific fields
    if (targetType === BroadcastTargetType.COMPANY && !companyId) {
      res.status(400).json({
        success: false,
        message: 'companyId is required when targetType is COMPANY',
      });
      return;
    }

    if (targetType === BroadcastTargetType.ROLE && !role) {
      res.status(400).json({
        success: false,
        message: 'role is required when targetType is ROLE',
      });
      return;
    }

    // Determine topic name based on targetType
    let topic: string;
    try {
      switch (targetType) {
        case BroadcastTargetType.ALL_USERS:
          topic = getAllUsersTopic();
          break;
        case BroadcastTargetType.COMPANY:
          topic = getCompanyTopic(companyId);
          break;
        case BroadcastTargetType.ROLE:
          topic = getRoleTopic(role);
          break;
        default:
          res.status(400).json({
            success: false,
            message: `Invalid targetType: ${targetType}`,
          });
          return;
      }
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: `Invalid topic: ${error.message || error}`,
      });
      return;
    }

    // Send broadcast notification to FCM topic (ONE message, scalable)
    let messageId: string;
    try {
      messageId = await NotificationService.sendBroadcastToTopic(
        {
          title,
          body,
          data: {
            type: 'BROADCAST',
            targetType,
            action: 'broadcast',
          },
        },
        topic
      );
      logger.info(`Broadcast notification sent to topic "${topic}", messageId: ${messageId}`);
    } catch (error: any) {
      logger.error({ error: error.message || error, topic }, 'Failed to send broadcast to FCM topic');
      res.status(500).json({
        success: false,
        message: 'Failed to send broadcast notification',
        error: error.message || 'Internal server error',
      });
      return;
    }

    // Create notification records in DB for all affected users
    // This ensures notifications appear in UI even if user was offline
    let notificationsCreated = 0;
    let userIds: string[] = [];
    try {
      const result = await NotificationDataService.createBroadcastNotification({
        title,
        description: body,
        targetType,
        companyId,
        role,
        createdBy,
        metadata: {
          messageId,
          topic,
        },
      });
      notificationsCreated = result.notificationsCreated;
      userIds = result.userIds;
      logger.info(`Created ${notificationsCreated} broadcast notification records in DB`);
    } catch (error: any) {
      // Log error but don't fail - FCM message was already sent
      logger.error({ error: error.message || error }, 'Failed to create broadcast notification records in DB');
    }

    // Emit real-time Socket.IO events
    try {
      if (targetType === BroadcastTargetType.ALL_USERS) {
        // Emit to all connected clients
        emitNotificationToAll({
          type: 'BROADCAST',
          title,
          description: body,
          targetType,
          isBroadcast: true,
          createdAt: new Date(),
        });
      } else if (targetType === BroadcastTargetType.COMPANY && companyId) {
        // Emit to company room
        emitToCompanyAdmin(
          companyId,
          CompanyAdminEvent.NOTIFICATION_CREATED,
          {
            type: 'BROADCAST',
            title,
            description: body,
            targetType,
            isBroadcast: true,
            createdAt: new Date(),
          }
        );
      }

      // Also emit to individual users who received the notification
      // (for real-time updates in their notification bell)
      for (const userId of userIds.slice(0, 100)) { // Limit to first 100 to avoid overwhelming Socket.IO
        emitNotificationToUser(userId, {
          type: 'BROADCAST',
          title,
          description: body,
          targetType,
          isBroadcast: true,
          createdAt: new Date(),
        });
      }
    } catch (error: any) {
      logger.warn({ error: error.message || error }, 'Failed to emit Socket.IO events for broadcast');
      // Don't fail the request - notification was already sent
    }

    res.status(200).json({
      success: true,
      message: 'Broadcast notification sent successfully',
      data: {
        messageId,
        topic,
        targetType,
        notificationsCreated,
        totalUsers: userIds.length,
      },
    });
  });
}


import mongoose from 'mongoose';

import { CompanyAdmin } from '../models/CompanyAdmin';
import { Notification, INotification, NotificationType } from '../models/Notification';
import { User } from '../models/User';
import { emitToCompanyAdmin , CompanyAdminEvent, emitNotificationToUser } from '../socket/realtimeEvents';
import { BroadcastTargetType } from '../utils/enums';

import { logger } from '@/config/logger';


export class NotificationDataService {
  /**
   * Create a notification for a user or company admin
   */
  static async createNotification(data: {
    userId?: string;
    companyId?: string;
    companyAdminId?: string;
    type: NotificationType;
    title: string;
    description: string;
    link?: string;
    metadata?: Record<string, any>;
  }): Promise<INotification> {
    let userId: string | undefined = data.userId;
    let companyId: string | undefined = data.companyId;

    // If companyAdminId is provided, get the company admin and their company
    if (data.companyAdminId) {
      const companyAdmin = await CompanyAdmin.findById(data.companyAdminId).exec();
      if (companyAdmin) {
        userId = (companyAdmin._id as any).toString();
        if (companyAdmin.companyId) {
          companyId = companyAdmin.companyId.toString();
        }
      }
    }

    // If companyId is provided but no userId, notify all company admins for that company
    if (companyId && !userId) {
      const companyAdmins = await CompanyAdmin.find({ companyId }).select('_id').exec();
      
      // Create notifications for all company admins
      const notifications = await Promise.all(
        companyAdmins.map(admin => 
          Notification.create({
            userId: admin._id,
            companyId: new mongoose.Types.ObjectId(companyId!),
            type: data.type,
            title: data.title,
            description: data.description,
            link: data.link,
            metadata: data.metadata,
            read: false,
          })
        )
      );

      // Emit real-time update to all company admins and individual users
      if (notifications.length > 0) {
        notifications.forEach(notification => {
          const userId = notification.userId.toString();
          emitToCompanyAdmin(
            companyId!,
            CompanyAdminEvent.NOTIFICATION_CREATED,
            notification.toObject()
          );
          emitNotificationToUser(userId, notification.toObject());
        });
      }

      return notifications[0]; // Return first notification
    }

    if (!userId) {
      throw new Error('Either userId or companyAdminId must be provided');
    }

    const notification = await Notification.create({
      userId: new mongoose.Types.ObjectId(userId),
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : undefined,
      type: data.type,
      title: data.title,
      description: data.description,
      link: data.link,
      metadata: data.metadata,
      read: false,
    });

    // Emit real-time update to user's socket room
    emitNotificationToUser(userId, notification.toObject());

    // Also emit to company admin room if companyId is provided
    if (companyId) {
      emitToCompanyAdmin(
        companyId,
        CompanyAdminEvent.NOTIFICATION_CREATED,
        notification.toObject()
      );
    }

    logger.debug(`Created notification: ${notification._id} for user ${userId}`);
    
    return notification;
  }

  /**
   * Get notifications for a company admin (by companyId)
   */
  static async getCompanyAdminNotifications(
    companyAdminId: string,
    filters: {
      type?: NotificationType;
      read?: boolean;
      limit?: number;
      page?: number;
    } = {}
  ): Promise<{ notifications: INotification[]; total: number; unreadCount: number }> {
    const companyAdmin = await CompanyAdmin.findById(companyAdminId).exec();
    if (!companyAdmin || !companyAdmin.companyId) {
      return { notifications: [], total: 0, unreadCount: 0 };
    }

    // companyId is not used in this function but kept for future use
    const userId = (companyAdmin._id as any).toString();

    // Notifications are stored per-recipient (userId required). Avoid broad companyId matching.
    const query: any = { userId: new mongoose.Types.ObjectId(userId) };

    if (filters.type) {
      query.type = filters.type;
    }

    if (filters.read !== undefined) {
      query.read = filters.read;
    }

    const limit = filters.limit || 50;
    const page = filters.page || 1;
    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      Notification.countDocuments(query),
      Notification.countDocuments({ ...query, read: false }),
    ]);

    return {
      notifications: notifications as unknown as INotification[],
      total,
      unreadCount,
    };
  }

  /**
   * Mark notification as read
   */
  static async markAsRead(notificationId: string, userId: string): Promise<INotification | null> {
    const notification = await Notification.findById(notificationId).exec();
    
    if (!notification) {
      return null;
    }

    // Verify the notification belongs to this user
    if (notification.userId.toString() !== userId) {
      throw new Error('Unauthorized to mark this notification as read');
    }

    notification.read = true;
    notification.readAt = new Date();
    await notification.save();

    // Emit real-time update if companyId exists
    if (notification.companyId) {
      emitToCompanyAdmin(
        notification.companyId.toString(),
        CompanyAdminEvent.NOTIFICATION_UPDATED,
        notification.toObject()
      );
    }

    return notification;
  }

  /**
   * Mark all notifications as read for a company admin
   */
  static async markAllAsRead(companyAdminId: string): Promise<number> {
    const companyAdmin = await CompanyAdmin.findById(companyAdminId).exec();
    if (!companyAdmin || !companyAdmin.companyId) {
      return 0;
    }

    const companyId = companyAdmin.companyId.toString();
    const userId = (companyAdmin._id as any).toString();

    const result = await Notification.updateMany(
      {
        userId: new mongoose.Types.ObjectId(userId),
        read: false,
      },
      {
        $set: {
          read: true,
          readAt: new Date(),
        },
      }
    );

    // Emit real-time update
    emitToCompanyAdmin(
      companyId,
      CompanyAdminEvent.NOTIFICATIONS_MARKED_READ,
      { count: result.modifiedCount }
    );

    return result.modifiedCount;
  }

  /**
   * Create broadcast notifications for all affected users
   * Uses bulk insert for performance
   */
  static async createBroadcastNotification(data: {
    title: string;
    description: string;
    targetType: BroadcastTargetType;
    companyId?: string;
    role?: string;
    createdBy: string;
    link?: string;
    metadata?: Record<string, any>;
  }): Promise<{ notificationsCreated: number; userIds: string[] }> {
    let users: any[] = [];

    // Fetch users based on targetType
    switch (data.targetType) {
      case BroadcastTargetType.ALL_USERS:
        users = await User.find({ status: 'ACTIVE' })
          .select('_id companyId')
          .lean()
          .exec();
        break;

      case BroadcastTargetType.COMPANY:
        if (!data.companyId) {
          throw new Error('companyId is required for COMPANY target type');
        }
        users = await User.find({
          companyId: new mongoose.Types.ObjectId(data.companyId),
          status: 'ACTIVE',
        })
          .select('_id companyId')
          .lean()
          .exec();
        break;

      case BroadcastTargetType.ROLE:
        if (!data.role) {
          throw new Error('role is required for ROLE target type');
        }
        users = await User.find({
          role: data.role,
          status: 'ACTIVE',
        })
          .select('_id companyId')
          .lean()
          .exec();
        break;

      default:
        throw new Error(`Invalid targetType: ${data.targetType}`);
    }

    if (users.length === 0) {
      logger.info(`No users found for broadcast notification with targetType: ${data.targetType}`);
      return { notificationsCreated: 0, userIds: [] };
    }

    // Prepare notification documents for bulk insert
    const notificationDocs = users.map((user) => ({
      userId: user._id,
      companyId: user.companyId ? new mongoose.Types.ObjectId(user.companyId) : undefined,
      type: NotificationType.BROADCAST,
      title: data.title,
      description: data.description,
      link: data.link,
      read: false,
      targetType: data.targetType,
      createdBy: new mongoose.Types.ObjectId(data.createdBy),
      isBroadcast: true,
      metadata: data.metadata || {},
    }));

    // Bulk insert in batches (Firebase/MongoDB limit is typically 1000 per batch)
    const BATCH_SIZE = 1000;
    let notificationsCreated = 0;
    const userIds: string[] = [];

    for (let i = 0; i < notificationDocs.length; i += BATCH_SIZE) {
      const batch = notificationDocs.slice(i, i + BATCH_SIZE);
      try {
        const result = await Notification.insertMany(batch, { ordered: false });
        notificationsCreated += result.length;
        userIds.push(...batch.map((doc) => doc.userId.toString()));
        logger.debug(`Inserted batch of ${result.length} broadcast notifications (${i + 1}-${Math.min(i + BATCH_SIZE, notificationDocs.length)} of ${notificationDocs.length})`);
      } catch (error: any) {
        // Log errors but continue with other batches
        // ordered: false means it continues even if some fail
        logger.error({ error: error.message || error, batchIndex: i }, 'Error inserting batch of broadcast notifications');
        // Count successful inserts from error result if available
        if (error.insertedDocs) {
          notificationsCreated += error.insertedDocs.length;
        }
      }
    }

    logger.info(`Created ${notificationsCreated} broadcast notifications for ${data.targetType}`);

    return { notificationsCreated, userIds };
  }
}


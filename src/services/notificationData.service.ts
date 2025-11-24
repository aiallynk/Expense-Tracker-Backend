import mongoose from 'mongoose';

import { CompanyAdmin } from '../models/CompanyAdmin';
import { Notification, INotification, NotificationType } from '../models/Notification';
import { emitToCompanyAdmin , CompanyAdminEvent } from '../socket/realtimeEvents';

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

      // Emit real-time update to all company admins
      if (notifications.length > 0) {
        notifications.forEach(notification => {
          emitToCompanyAdmin(
            companyId!,
            CompanyAdminEvent.NOTIFICATION_CREATED,
            notification.toObject()
          );
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

    // Emit real-time update if companyId is provided
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

    const companyId = companyAdmin.companyId.toString();
    const userId = (companyAdmin._id as any).toString();

    const query: any = {
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) },
        { companyId: new mongoose.Types.ObjectId(companyId) },
      ],
    };

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
        $or: [
          { userId: new mongoose.Types.ObjectId(userId) },
          { companyId: new mongoose.Types.ObjectId(companyId) },
        ],
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
}


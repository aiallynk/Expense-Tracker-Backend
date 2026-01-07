import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { NotificationDataService } from '../services/notificationData.service';
import { emitNotificationToUser } from '../socket/realtimeEvents';

export class NotificationController {
  /**
   * Get notifications for current user
   */
  static getNotifications = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    // Get user or company admin to check existence and company isolation
    let user: any = await User.findById(userId).select('companyId').exec();

    // If not found in User, check CompanyAdmin
    if (!user) {
      user = await CompanyAdmin.findById(userId).select('companyId').exec();
    }

    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User associated with token not found',
      });
      return;
    }

    // IMPORTANT:
    // Notifications are per-recipient records (userId is required in schema).
    // Do NOT include companyId-based matching here, otherwise users see other peoples' notifications.
    const query: any = { userId: new mongoose.Types.ObjectId(userId) };

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      Notification.countDocuments(query),
      Notification.countDocuments({ ...query, read: false }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        notifications,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        unreadCount,
      },
    });
  });

  /**
   * Get unread notification count
   */
  static getUnreadCount = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;

    let user: any = await User.findById(userId).select('companyId').exec();

    // If not found in User, check CompanyAdmin
    if (!user) {
      user = await CompanyAdmin.findById(userId).select('companyId').exec();
    }

    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User associated with token not found',
      });
      return;
    }

    // Only count unread notifications for this specific user (avoid companyId broad match)
    const query: any = { userId: new mongoose.Types.ObjectId(userId), read: false };

    const unreadCount = await Notification.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        unreadCount,
      },
    });
  });

  /**
   * Mark notification as read
   */
  static markAsRead = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const notificationId = req.params.id;

    const notification = await NotificationDataService.markAsRead(notificationId, userId);

    if (!notification) {
      res.status(404).json({
        success: false,
        message: 'Notification not found',
      });
      return;
    }

    // Emit real-time update
    emitNotificationToUser(userId, notification.toObject());

    res.status(200).json({
      success: true,
      data: notification,
      message: 'Notification marked as read',
    });
  });

  /**
   * Mark all notifications as read
   */
  static markAllAsRead = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;

    let user: any = await User.findById(userId).select('companyId').exec();

    // If not found in User, check CompanyAdmin
    if (!user) {
      user = await CompanyAdmin.findById(userId).select('companyId').exec();
    }

    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User associated with token not found',
      });
      return;
    }

    // Mark read only for current user
    const query: any = { userId: new mongoose.Types.ObjectId(userId), read: false };

    const result = await Notification.updateMany(
      query,
      {
        $set: {
          read: true,
          readAt: new Date(),
        },
      }
    );

    // Emit real-time update
    emitNotificationToUser(userId, { type: 'notifications_marked_read', count: result.modifiedCount });

    res.status(200).json({
      success: true,
      data: {
        count: result.modifiedCount,
      },
      message: `${result.modifiedCount} notifications marked as read`,
    });
  });

  /**
   * Clear (delete) all notifications for current user
   * DELETE /api/v1/notifications
   */
  static clearAll = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;

    // Verify token user still exists (User or CompanyAdmin)
    let user: any = await User.findById(userId).select('_id').exec();
    if (!user) {
      user = await CompanyAdmin.findById(userId).select('_id').exec();
    }
    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User associated with token not found',
      });
      return;
    }

    const result = await Notification.deleteMany({ userId: new mongoose.Types.ObjectId(userId) }).exec();

    res.status(200).json({
      success: true,
      data: { count: result.deletedCount || 0 },
      message: `Cleared ${result.deletedCount || 0} notifications`,
    });
  });
}


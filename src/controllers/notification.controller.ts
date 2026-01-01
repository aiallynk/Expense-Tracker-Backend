import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { Notification } from '../models/Notification';
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

    // Get user to check company isolation
    const { User } = await import('../models/User');
    const user = await User.findById(userId).select('companyId').exec();

    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found',
      });
      return;
    }

    // Build query - user's notifications or company-wide notifications
    const query: any = {
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) },
      ],
    };

    // Include company-wide notifications if user has a company
    if (user.companyId) {
      query.$or.push({ companyId: user.companyId });
    }

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

    const { User } = await import('../models/User');
    const user = await User.findById(userId).select('companyId').exec();

    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found',
      });
      return;
    }

    const query: any = {
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) },
      ],
      read: false,
    };

    if (user.companyId) {
      query.$or.push({ companyId: user.companyId });
    }

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

    const { User } = await import('../models/User');
    const user = await User.findById(userId).select('companyId').exec();

    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found',
      });
      return;
    }

    const query: any = {
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) },
      ],
      read: false,
    };

    if (user.companyId) {
      query.$or.push({ companyId: user.companyId });
    }

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
}


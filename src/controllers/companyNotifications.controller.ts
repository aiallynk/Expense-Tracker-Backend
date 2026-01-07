import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { Notification , NotificationType } from '../models/Notification';
import { NotificationDataService } from '../services/notificationData.service';

export class CompanyNotificationsController {
  /**
   * Get notifications for company admin
   * GET /api/v1/company-admin/notifications
   */
  static getNotifications = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyAdminId = req.user!.id;
    const filters = {
      type: req.query.type as NotificationType | undefined,
      read: req.query.read === 'true' ? true : req.query.read === 'false' ? false : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
    };

    const result = await NotificationDataService.getCompanyAdminNotifications(
      companyAdminId,
      filters
    );

    res.status(200).json({
      success: true,
      data: result.notifications,
      pagination: {
        total: result.total,
        unreadCount: result.unreadCount,
        page: filters.page,
        pageSize: filters.limit,
      },
    });
  });

  /**
   * Mark notification as read
   * PUT /api/v1/company-admin/notifications/:id/read
   */
  static markAsRead = asyncHandler(async (req: AuthRequest, res: Response) => {
    const notificationId = req.params.id;
    const userId = req.user!.id;

    const notification = await NotificationDataService.markAsRead(notificationId, userId);

    if (!notification) {
      res.status(404).json({
        success: false,
        message: 'Notification not found',
        code: 'NOTIFICATION_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      data: notification,
    });
  });

  /**
   * Mark all notifications as read
   * PUT /api/v1/company-admin/notifications/read-all
   */
  static markAllAsRead = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyAdminId = req.user!.id;

    const count = await NotificationDataService.markAllAsRead(companyAdminId);

    res.status(200).json({
      success: true,
      message: `Marked ${count} notifications as read`,
      data: { count },
    });
  });

  /**
   * Clear (delete) all notifications for this company admin user only
   * DELETE /api/v1/company-admin/notifications
   */
  static clearAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyAdminId = req.user!.id;

    // Only delete notifications addressed to this company admin (NOT company-wide)
    const result = await Notification.deleteMany({
      userId: new mongoose.Types.ObjectId(companyAdminId),
    }).exec();

    res.status(200).json({
      success: true,
      message: `Cleared ${result.deletedCount || 0} notifications`,
      data: { count: result.deletedCount || 0 },
    });
  });
}


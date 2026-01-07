import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import {
  NotificationBroadcastChannel,
  NotificationBroadcastStatus,
  NotificationBroadcastType,
} from '../models/NotificationBroadcast';
import { NotificationBroadcastService } from '../services/notificationBroadcast.service';
import { BroadcastTargetType } from '../utils/enums';

export class NotificationBroadcastController {
  /**
   * POST /api/v1/admin/notifications/broadcast
   * SUPER_ADMIN only (enforced by route middleware + service)
   */
  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const actorId = req.user!.id;

    const scheduledAtRaw = req.body?.scheduledAt;
    const scheduledAt =
      scheduledAtRaw === null || scheduledAtRaw === undefined || scheduledAtRaw === ''
        ? null
        : new Date(scheduledAtRaw);

    const broadcast = await NotificationBroadcastService.createBroadcast(actorId, {
      title: req.body.title,
      message: req.body.message,
      type: req.body.type as NotificationBroadcastType,
      targetType: req.body.targetType as BroadcastTargetType,
      companyId: req.body.companyId,
      channels: req.body.channels as NotificationBroadcastChannel[],
      scheduledAt,
    });

    res.status(201).json({ success: true, data: broadcast });
  });

  /**
   * GET /api/v1/admin/notifications/broadcasts
   */
  static list = asyncHandler(async (req: AuthRequest, res: Response) => {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

    const status = req.query.status as NotificationBroadcastStatus | undefined;
    const targetType = req.query.targetType as BroadcastTargetType | undefined;
    const companyId = req.query.companyId as string | undefined;

    const result = await NotificationBroadcastService.listBroadcasts({
      page,
      limit,
      status,
      targetType,
      companyId,
    });

    res.status(200).json({
      success: true,
      data: result.broadcasts,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: Math.ceil(result.total / limit),
      },
    });
  });
}



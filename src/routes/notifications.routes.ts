import { Router } from 'express';
import { z } from 'zod';

import { authMiddleware , AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { NotificationService } from '../services/notification.service';
import { NotificationController } from '../controllers/notification.controller';
import { NotificationPlatform } from '../utils/enums';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

const registerTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.nativeEnum(NotificationPlatform),
});

router.post(
  '/register-token',
  asyncHandler(async (req: AuthRequest, res) => {
    const data = registerTokenSchema.parse(req.body);
    await NotificationService.registerFcmToken(
      req.user!.id,
      data.token,
      data.platform
    );

    res.status(200).json({
      success: true,
      message: 'FCM token registered successfully',
    });
  })
);

// Get user's notifications
router.get('/', NotificationController.getNotifications);

// Get unread count
router.get('/unread-count', NotificationController.getUnreadCount);

// Mark notification as read
router.put('/:id/read', NotificationController.markAsRead);

// Mark all notifications as read
router.put('/read-all', NotificationController.markAllAsRead);

export default router;


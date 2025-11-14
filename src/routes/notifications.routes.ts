import { Router } from 'express';
import { NotificationService } from '../services/notification.service';
import { authMiddleware } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { z } from 'zod';
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

export default router;


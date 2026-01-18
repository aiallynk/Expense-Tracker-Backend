import { Router } from 'express';
import { z } from 'zod';

import { AuthController } from '../controllers/auth.controller';
import { loginRateLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import { loginSchema, refreshTokenSchema, changePasswordSchema } from '../utils/dtoTypes';
import { UserRole } from '../utils/enums';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  role: z.nativeEnum(UserRole).optional(),
});

router.post(
  '/signup',
  loginRateLimiter,
  validate(signupSchema),
  AuthController.signup
);

router.post(
  '/login',
  loginRateLimiter,
  validate(loginSchema),
  AuthController.login
);

router.post(
  '/refresh',
  validate(refreshTokenSchema),
  AuthController.refresh
);

router.post(
  '/check-roles',
  loginRateLimiter,
  AuthController.checkRoles
);

router.post('/logout', AuthController.logout);

router.post(
  '/forgot-password',
  loginRateLimiter,
  AuthController.forgotPassword
);

router.post(
  '/reset-password',
  loginRateLimiter,
  AuthController.resetPassword
);

router.post(
  '/change-password',
  authMiddleware,
  loginRateLimiter,
  validate(changePasswordSchema),
  AuthController.changePassword
);

export default router;


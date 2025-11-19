import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { loginRateLimiter } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validate.middleware';
import { loginSchema, refreshTokenSchema } from '../utils/dtoTypes';
import { z } from 'zod';
import { UserRole } from '../utils/enums';

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

router.post('/logout', AuthController.logout);

export default router;


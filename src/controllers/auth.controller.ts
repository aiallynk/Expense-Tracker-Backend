import { Request, Response } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../middleware/error.middleware';
import { AuthService } from '../services/auth.service';
import { loginSchema, refreshTokenSchema, changePasswordSchema } from '../utils/dtoTypes';
import { AuthRequest } from '../middleware/auth.middleware';
import { UserRole } from '../utils/enums';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  role: z.nativeEnum(UserRole).optional(),
});

export class AuthController {
  static signup = asyncHandler(async (req: Request, res: Response) => {
    const data = signupSchema.parse(req.body);
    const result = await AuthService.signup(
      data.email,
      data.password,
      data.name,
      data.role
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  });

  static login = asyncHandler(async (req: Request, res: Response) => {
    try {
      const data = loginSchema.parse(req.body);
      const result = await AuthService.login(data.email, data.password);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      // Log the error for debugging
      const { logger } = require('../config/logger');
      logger.error({ 
        error: error?.message || error, 
        stack: error?.stack,
        email: req.body?.email 
      }, 'Login endpoint error');
      
      // Re-throw to be handled by error middleware
      throw error;
    }
  });

  static refresh = asyncHandler(async (req: Request, res: Response) => {
    const data = refreshTokenSchema.parse(req.body);
    const result = await AuthService.refresh(data.refreshToken);

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  static checkRoles = asyncHandler(async (req: Request, res: Response) => {
    const emailSchema = z.object({
      email: z.string().email('Invalid email address'),
    });
    const data = emailSchema.parse(req.body);
    const result = await AuthService.checkUserRoles(data.email);

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  static logout = asyncHandler(async (_req: Request, res: Response) => {
    // In a production system, you might want to blacklist the refresh token
    // For now, we'll just return success
    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  });

  static forgotPassword = asyncHandler(async (req: Request, res: Response) => {
    const emailSchema = z.object({
      email: z.string().email('Invalid email address'),
    });
    const data = emailSchema.parse(req.body);
    const result = await AuthService.forgotPassword(data.email);

    res.status(200).json({
      success: result.success,
      message: result.message,
    });
  });

  static resetPassword = asyncHandler(async (req: Request, res: Response) => {
    const resetPasswordSchema = z.object({
      token: z.string().min(1, 'Reset token is required'),
      password: z.string().min(6, 'Password must be at least 6 characters'),
    });
    const data = resetPasswordSchema.parse(req.body);
    const result = await AuthService.resetPassword(data.token, data.password);

    res.status(200).json({
      success: result.success,
      message: result.message,
    });
  });

  static changePassword = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = changePasswordSchema.parse(req.body);
    const result = await AuthService.changePassword(
      req.user!.id,
      data.currentPassword,
      data.newPassword,
      req.user!.role
    );

    res.status(200).json({
      success: result.success,
      message: result.message,
    });
  });
}


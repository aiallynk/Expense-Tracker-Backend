import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { asyncHandler } from '../middleware/error.middleware';
import { loginSchema, refreshTokenSchema } from '../utils/dtoTypes';
import { z } from 'zod';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
});

export class AuthController {
  static signup = asyncHandler(async (req: Request, res: Response) => {
    const data = signupSchema.parse(req.body);
    const result = await AuthService.signup(
      data.email,
      data.password,
      data.name
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  });

  static login = asyncHandler(async (req: Request, res: Response) => {
    const data = loginSchema.parse(req.body);
    const result = await AuthService.login(data.email, data.password);

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  static refresh = asyncHandler(async (req: Request, res: Response) => {
    const data = refreshTokenSchema.parse(req.body);
    const result = await AuthService.refresh(data.refreshToken);

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  static logout = asyncHandler(async (req: Request, res: Response) => {
    // In a production system, you might want to blacklist the refresh token
    // For now, we'll just return success
    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  });
}


import { Response } from 'express';
import { UsersService } from '../services/users.service';
import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { updateProfileSchema } from '../utils/dtoTypes';

export class UsersController {
  static getMe = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await UsersService.getCurrentUser(req.user!.id);

    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  });

  static updateProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateProfileSchema.parse(req.body);
    const user = await UsersService.updateProfile(req.user!.id, data);

    res.status(200).json({
      success: true,
      data: user,
    });
  });

  static getAllUsers = asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = {
      role: req.query.role as string | undefined,
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      pageSize: req.query.pageSize
        ? parseInt(req.query.pageSize as string, 10)
        : undefined,
    };

    const result = await UsersService.getAllUsers(filters);

    res.status(200).json({
      success: true,
      data: result.users,
      pagination: {
        total: result.total,
        page: filters.page || 1,
        pageSize: filters.pageSize || 20,
      },
    });
  });
}


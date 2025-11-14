import { User, IUser } from '../models/User';
import { UpdateProfileDto } from '../utils/dtoTypes';
import { AuthRequest } from '../middleware/auth.middleware';
import mongoose from 'mongoose';

export class UsersService {
  static async getCurrentUser(userId: string): Promise<IUser | null> {
    return User.findById(userId).select('-passwordHash').exec();
  }

  static async updateProfile(
    userId: string,
    data: UpdateProfileDto
  ): Promise<IUser> {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    if (data.name !== undefined) {
      user.name = data.name;
    }

    return user.save();
  }

  static async getAllUsers(
    filters: {
      role?: string;
      status?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    }
  ): Promise<{ users: IUser[]; total: number }> {
    const query: any = {};

    if (filters.role) {
      query.role = filters.role;
    }

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.search) {
      query.$or = [
        { email: { $regex: filters.search, $options: 'i' } },
        { name: { $regex: filters.search, $options: 'i' } },
      ];
    }

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 20;
    const skip = (page - 1) * pageSize;

    const [users, total] = await Promise.all([
      User.find(query)
        .select('-passwordHash')
        .skip(skip)
        .limit(pageSize)
        .sort({ createdAt: -1 })
        .exec(),
      User.countDocuments(query).exec(),
    ]);

    return { users, total };
  }

  static async getUserById(id: string): Promise<IUser | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return User.findById(id).select('-passwordHash').exec();
  }
}


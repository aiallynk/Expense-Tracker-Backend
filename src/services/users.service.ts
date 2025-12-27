import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

import { CompanyAdmin, ICompanyAdmin } from '../models/CompanyAdmin';
import { User, IUser } from '../models/User';
import { emitCompanyAdminDashboardUpdate, emitUserCreated, emitUserUpdated, emitToUser } from '../socket/realtimeEvents';
import { UpdateProfileDto, UpdateUserDto } from '../utils/dtoTypes';

// import { AuthRequest } from '../middleware/auth.middleware'; // Unused

import { UserRole, UserStatus , AuditAction } from '../utils/enums';

import { AuditService } from './audit.service';
import { CompanyAdminDashboardService } from './companyAdminDashboard.service';

import { logger } from '@/config/logger';

export class UsersService {
  static async getCurrentUser(userId: string, role?: string): Promise<IUser | ICompanyAdmin | null> {
    // If role is COMPANY_ADMIN, fetch from CompanyAdmin collection
    if (role === 'COMPANY_ADMIN') {
      const admin = await CompanyAdmin.findById(userId)
        .select('-passwordHash')
        .populate('companyId', 'name domain')
        .exec();
      return admin;
    }
    // Otherwise, fetch from User collection with populated company and department
    return User.findById(userId)
      .select('-passwordHash')
      .populate('companyId', 'name domain shortcut')
      .populate('departmentId', 'name code')
      .exec();
  }

  static async updateProfile(
    userId: string,
    data: UpdateProfileDto,
    role?: string
  ): Promise<IUser | ICompanyAdmin> {
    // If role is COMPANY_ADMIN, update CompanyAdmin record
    if (role === 'COMPANY_ADMIN') {
      const admin = await CompanyAdmin.findById(userId);

      if (!admin) {
        throw new Error('Company admin not found');
      }

      if (data.name !== undefined) {
        admin.name = data.name.trim();
      }

      if (data.phone !== undefined) {
        admin.phone = data.phone ? data.phone.trim() : undefined;
      }

      await admin.save();
      
      // Return admin without passwordHash (similar to getCurrentUser)
      const adminObj = admin.toObject();
      if ('passwordHash' in adminObj) {
        delete (adminObj as any).passwordHash;
      }
      return adminObj as ICompanyAdmin;
    }

    // Otherwise, update User record
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    if (data.name !== undefined) {
      user.name = data.name.trim();
    }

    if (data.phone !== undefined) {
      user.phone = data.phone ? data.phone.trim() : undefined;
    }

    // Track if company or department changed
    let companyChanged = false;
    let departmentChanged = false;

    // Allow setting companyId and departmentId only if not already set
    if (data.companyId !== undefined) {
      if (!user.companyId) {
        // Only allow setting if not already set
        user.companyId = new mongoose.Types.ObjectId(data.companyId);
        companyChanged = true;
      } else if (user.companyId.toString() !== data.companyId) {
        // If already set and trying to change, throw error
        throw new Error('Company cannot be changed. Please contact an administrator.');
      }
    }

    if (data.departmentId !== undefined) {
      // Validate that department belongs to the user's company
      const targetCompanyId = data.companyId || user.companyId;
      if (data.departmentId && targetCompanyId) {
        const { Department } = await import('../models/Department');
        const department = await Department.findById(data.departmentId).exec();
        if (department && department.companyId.toString() !== targetCompanyId.toString()) {
          throw new Error('Department does not belong to your company');
        }
      }
      
      if (!user.departmentId) {
        // Only allow setting if not already set
        if (data.departmentId) {
          user.departmentId = new mongoose.Types.ObjectId(data.departmentId);
          departmentChanged = true;
        }
      } else if (data.departmentId && user.departmentId.toString() !== data.departmentId) {
        // If already set and trying to change, throw error
        throw new Error('Department cannot be changed. Please contact an administrator.');
      }
    }

    // Auto-generate employee ID if company/department was set
    if (companyChanged || (departmentChanged && user.companyId)) {
      const { EmployeeIdService } = await import('./employeeId.service');
      try {
        const employeeId = await EmployeeIdService.assignEmployeeId(
          userId,
          user.companyId,
          user.departmentId
        );
        if (employeeId) {
          user.employeeId = employeeId;
        }
       } catch (error: any) {
         // Log error but don't fail the update
         logger.error({ error }, 'Error generating employee ID');
       }
    }

    const updatedUser = await user.save();
    // Populate company and department before returning
    const result = await User.findById(updatedUser._id)
      .populate('companyId', 'name domain shortcut')
      .populate('departmentId', 'name code')
      .select('-passwordHash')
      .exec();
    
    // Emit profile update to the user themselves for real-time updates
    if (result) {
      const formattedUser = {
        id: (result._id as any).toString(),
        name: result.name,
        email: result.email,
        phone: result.phone,
        employeeId: result.employeeId,
        role: result.role,
        companyId: result.companyId ? {
          _id: (result.companyId as any)._id?.toString() || (result.companyId as any).toString(),
          name: (result.companyId as any).name || null,
        } : null,
        departmentId: result.departmentId ? {
          _id: (result.departmentId as any)._id?.toString() || (result.departmentId as any).toString(),
          name: (result.departmentId as any).name || null,
        } : null,
      };
      emitToUser(userId, 'user:profile-updated', formattedUser);
      logger.debug({ userId }, 'Emitted profile update to user');
    }
    
    // Emit to company admin if user has company
    if (result?.companyId) {
      const companyId = typeof result.companyId === 'object' 
        ? (result.companyId as any)._id?.toString() 
        : (result.companyId as any).toString();
      const formattedUser = {
        id: (result._id as any).toString(),
        name: result.name,
        email: result.email,
        phone: result.phone,
        employeeId: result.employeeId,
        role: result.role,
        companyId: companyId,
        departmentId: result.departmentId ? {
          _id: (result.departmentId as any)._id?.toString() || (result.departmentId as any).toString(),
          name: (result.departmentId as any).name || null,
        } : null,
      };
      emitUserUpdated(companyId, formattedUser);
    }
    
    return result || updatedUser;
  }

  static async getAllUsers(
    filters: {
      role?: string;
      status?: string;
      search?: string;
      page?: number;
      pageSize?: number;
      companyId?: string;
      departmentId?: string;
      excludeAdminRoles?: boolean;
    }
  ): Promise<{ users: IUser[]; total: number }> {
    const query: any = {};

    // Filter by companyId if provided
    if (filters.companyId) {
      query.companyId = new mongoose.Types.ObjectId(filters.companyId);
    }

    // Filter by departmentId if provided
    if (filters.departmentId) {
      query.departmentId = new mongoose.Types.ObjectId(filters.departmentId);
    }

    // Exclude admin roles (COMPANY_ADMIN, SUPER_ADMIN, ADMIN) if requested
    // Only show EMPLOYEE, MANAGER, BUSINESS_HEAD, and ACCOUNTANT (exclude ADMIN, COMPANY_ADMIN, SUPER_ADMIN)
    if (filters.excludeAdminRoles) {
      // If specific role is requested and it's a valid non-admin role, use it
      if (filters.role && [UserRole.EMPLOYEE, UserRole.MANAGER, UserRole.BUSINESS_HEAD, UserRole.ACCOUNTANT].includes(filters.role as UserRole)) {
        query.role = filters.role;
      } else {
        // Otherwise, filter to only show non-admin roles
        query.role = { $in: [UserRole.EMPLOYEE, UserRole.MANAGER, UserRole.BUSINESS_HEAD, UserRole.ACCOUNTANT] };
      }
    } else if (filters.role) {
      // If not excluding admin roles, filter by the requested role
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
        .populate('managerId', 'name email')
        .populate('departmentId', 'name code')
        .skip(skip)
        .limit(pageSize)
        .sort({ createdAt: -1 })
        .exec(),
      User.countDocuments(query).exec(),
    ]);

    return { users, total };
  }

  static async getUserById(id: string, companyId?: string): Promise<IUser | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    
    const query: any = { _id: id };
    
    // If companyId is provided, ensure user belongs to that company
    if (companyId) {
      query.companyId = new mongoose.Types.ObjectId(companyId);
    }
    
    return User.findOne(query)
      .select('-passwordHash')
      .populate('managerId', 'name email')
      .populate('departmentId', 'name code')
      .exec();
  }

  static async createUser(data: {
    email: string;
    password: string;
    name: string;
    phone?: string;
    role: UserRole;
    companyId?: string;
    managerId?: string;
    departmentId?: string;
    status?: UserStatus;
  }): Promise<IUser> {
    // Check if user already exists
    const existingUser = await User.findOne({ email: data.email.toLowerCase() });
    if (existingUser) {
      const error: any = new Error('User with this email already exists');
      error.statusCode = 409;
      error.code = 'USER_ALREADY_EXISTS';
      throw error;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(data.password, 10);

    // Create user
    const user = new User({
      email: data.email.toLowerCase(),
      passwordHash,
      name: data.name,
      phone: data.phone || undefined,
      role: data.role,
      status: data.status || UserStatus.ACTIVE,
      companyId: data.companyId ? new mongoose.Types.ObjectId(data.companyId) : undefined,
      managerId: data.managerId ? new mongoose.Types.ObjectId(data.managerId) : undefined,
      departmentId: data.departmentId ? new mongoose.Types.ObjectId(data.departmentId) : undefined,
    });

    await user.save();

    // Audit log
    const userId = (user._id as mongoose.Types.ObjectId).toString();
    await AuditService.log(
      userId,
      'User',
      userId,
      AuditAction.CREATE
    );

    // Return user without password hash
    const userObj = user.toObject();
    if ('passwordHash' in userObj) {
      delete (userObj as any).passwordHash;
    }

    // Emit real-time events if user has a company
    if (user.companyId) {
      try {
        const companyId = user.companyId.toString();
        
        // Fetch populated user data for real-time event
        const populatedUser = await User.findById(user._id)
          .select('-passwordHash')
          .populate('managerId', 'name email')
          .populate('departmentId', 'name code')
          .exec();
        
        if (populatedUser) {
          // Emit user created event (send formatted user data)
          const formattedUser = {
            id: populatedUser._id?.toString(),
            _id: populatedUser._id?.toString(),
            name: populatedUser.name,
            email: populatedUser.email,
            phone: populatedUser.phone,
            role: populatedUser.role,
            status: populatedUser.status,
            departmentId: populatedUser.departmentId,
            managerId: populatedUser.managerId,
            companyId: populatedUser.companyId,
          };
          emitUserCreated(companyId, formattedUser);
        }
        
        // Emit dashboard stats update
        const stats = await CompanyAdminDashboardService.getDashboardStatsForCompany(companyId);
        emitCompanyAdminDashboardUpdate(companyId, stats);
      } catch (error) {
        // Don't fail user creation if real-time updates fail
        logger.error({ error }, 'Error emitting real-time updates');
      }
    }

    return userObj as IUser;
  }

  static async updateUser(
    userId: string,
    data: UpdateUserDto,
    requestingUserId: string,
    requestingUserRole: string
  ): Promise<IUser> {
    const user = await User.findById(userId);
    
    if (!user) {
      const error: any = new Error('User not found');
      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';
      throw error;
    }

    // If requesting user is COMPANY_ADMIN, ensure they can only update users in their company
    if (requestingUserRole === 'COMPANY_ADMIN') {
      const { CompanyAdmin } = await import('../models/CompanyAdmin');
      const companyAdmin = await CompanyAdmin.findById(requestingUserId).exec();
      if (companyAdmin && companyAdmin.companyId) {
        const userCompanyId = user.companyId?.toString();
        const adminCompanyId = companyAdmin.companyId.toString();
        if (userCompanyId !== adminCompanyId) {
          const error: any = new Error('Access denied: Cannot update users from other companies');
          error.statusCode = 403;
          error.code = 'ACCESS_DENIED';
          throw error;
        }
      }
      
      // Ensure COMPANY_ADMIN cannot change role to admin roles
      if (data.role && ![UserRole.EMPLOYEE, UserRole.MANAGER, UserRole.BUSINESS_HEAD, UserRole.ACCOUNTANT].includes(data.role as UserRole)) {
        const error: any = new Error('Company admins can only assign EMPLOYEE, MANAGER, BUSINESS_HEAD, or ACCOUNTANT roles');
        error.statusCode = 403;
        error.code = 'INVALID_ROLE';
        throw error;
      }
    }

    // Update fields
    if (data.name !== undefined) {
      user.name = data.name;
    }
    
    if (data.phone !== undefined) {
      user.phone = data.phone || undefined;
    }
    
    if (data.email !== undefined) {
      // Check if email is already taken by another user
      const existingUser = await User.findOne({ 
        email: data.email.toLowerCase(),
        _id: { $ne: userId }
      });
      if (existingUser) {
        const error: any = new Error('Email already in use');
        error.statusCode = 409;
        error.code = 'EMAIL_ALREADY_EXISTS';
        throw error;
      }
      user.email = data.email.toLowerCase();
    }
    
    if (data.role !== undefined) {
      user.role = data.role as UserRole;
    }
    
    if (data.departmentId !== undefined) {
      user.departmentId = data.departmentId 
        ? new mongoose.Types.ObjectId(data.departmentId) 
        : undefined;
    }
    
    if (data.managerId !== undefined) {
      user.managerId = data.managerId 
        ? new mongoose.Types.ObjectId(data.managerId) 
        : undefined;
    }
    
    if (data.status !== undefined) {
      user.status = data.status as UserStatus;
    }

    await user.save();

    // Audit log
    await AuditService.log(
      requestingUserId,
      'User',
      userId,
      AuditAction.UPDATE
    );

    // Return populated user
    const updatedUser = await User.findById(userId)
      .select('-passwordHash')
      .populate('managerId', 'name email')
      .populate('departmentId', 'name code')
      .exec();

    if (!updatedUser) {
      throw new Error('Failed to retrieve updated user');
    }

    // Emit real-time events if user has a company
    if (updatedUser.companyId) {
      try {
        const companyId = updatedUser.companyId.toString();
        
        // Emit user updated event (send formatted user data with populated fields)
        const formattedUser = {
          id: updatedUser._id?.toString(),
          _id: updatedUser._id?.toString(),
          name: updatedUser.name,
          email: updatedUser.email,
          phone: updatedUser.phone,
          role: updatedUser.role,
          status: updatedUser.status,
          departmentId: updatedUser.departmentId, // Already populated
          managerId: updatedUser.managerId, // Already populated
          companyId: updatedUser.companyId,
        };
        emitUserUpdated(companyId, formattedUser);
        
        // Emit dashboard stats update
        const stats = await CompanyAdminDashboardService.getDashboardStatsForCompany(companyId);
        emitCompanyAdminDashboardUpdate(companyId, stats);
      } catch (error) {
        // Don't fail user update if real-time updates fail
        logger.error({ error }, 'Error emitting real-time updates');
      }
    }

    return updatedUser;
  }
}


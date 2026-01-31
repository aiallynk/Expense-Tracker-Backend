import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

import { CompanyAdmin, ICompanyAdmin } from '../models/CompanyAdmin';
import { Role } from '../models/Role';
import { User, IUser } from '../models/User';
import { emitUserCreated, emitUserUpdated, emitToUser } from '../socket/realtimeEvents';
import { UpdateProfileDto, UpdateUserDto } from '../utils/dtoTypes';
import { UserRole, UserStatus, AuditAction } from '../utils/enums';

// import { AuthRequest } from '../middleware/auth.middleware'; // Unused

import { AuditService } from './audit.service';
import { enqueueAnalyticsEvent } from './companyAnalyticsSnapshot.service';
import { SystemAnalyticsService } from './systemAnalytics.service';

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
      .populate('roles', 'name type') // Populate approval roles
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

      if (data.profileImage !== undefined) {
        (admin as any).profileImage = data.profileImage || undefined;
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

    if (data.profileImage !== undefined) {
      user.profileImage = data.profileImage || undefined;
    }

    if (data.notificationSettings !== undefined) {
      user.notificationSettings = {
        push: data.notificationSettings.push ?? user.notificationSettings?.push ?? true,
        email: data.notificationSettings.email ?? user.notificationSettings?.email ?? true,
        expenseUpdates: data.notificationSettings.expenseUpdates ?? user.notificationSettings?.expenseUpdates ?? true,
        reportStatus: data.notificationSettings.reportStatus ?? user.notificationSettings?.reportStatus ?? true,
        approvalAlerts: data.notificationSettings.approvalAlerts ?? user.notificationSettings?.approvalAlerts ?? true
      };
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
        companyId,
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

  /**
   * Get users eligible as project managers: company roles (EMPLOYEE, MANAGER, BUSINESS_HEAD, ACCOUNTANT)
   * or users who have at least one custom role (Role type CUSTOM) for the company.
   */
  static async getEligibleProjectManagers(companyId: string): Promise<IUser[]> {
    const companyObjectId = new mongoose.Types.ObjectId(companyId);
    const customRoles = await Role.find({
      companyId: companyObjectId,
      type: 'CUSTOM',
      isActive: true,
    })
      .select('_id')
      .lean()
      .exec();
    const customRoleIds = customRoles.map((r) => r._id);

    const query: any = {
      companyId: companyObjectId,
      status: UserStatus.ACTIVE,
      $or: [
        { role: { $in: [UserRole.EMPLOYEE, UserRole.MANAGER, UserRole.BUSINESS_HEAD, UserRole.ACCOUNTANT] } },
        ...(customRoleIds.length > 0 ? [{ roles: { $in: customRoleIds } }] : []),
      ],
    };

    return User.find(query)
      .select('_id name email role')
      .populate('roles', 'name type')
      .sort({ name: 1 })
      .lean()
      .exec() as unknown as Promise<IUser[]>;
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
    email?: string;
    password?: string;
    name?: string;
    phone?: string;
    role?: UserRole;
    roles?: string[]; // Additional roles array
    companyId?: string;
    managerId?: string;
    departmentId?: string;
    status?: UserStatus;
    employeeId?: string;
  }): Promise<IUser> {
    // Generate email if not provided (use placeholder format)
    let email = data.email?.trim() || '';
    if (!email || email === '') {
      // Generate a temporary email based on name or timestamp
      const namePart = data.name?.trim().toLowerCase().replace(/\s+/g, '.') || 'user';
      const timestamp = Date.now();
      email = `${namePart}.${timestamp}@temp.imported`;
    } else {
      email = email.toLowerCase();
    }

    // Check if user already exists (only if email is provided and not a temp email)
    if (!email.includes('@temp.imported')) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        const error: any = new Error(`User with email ${email} already exists`);
        error.statusCode = 409;
        error.code = 'USER_ALREADY_EXISTS';
        throw error;
      }
    }

    // Generate password if not provided
    let password = data.password?.trim() || '';
    if (!password || password === '') {
      // Generate a secure random password
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
      password = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      logger.info({ email }, 'Generated temporary password for imported user');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Use provided name or default
    const name = data.name?.trim() || email.split('@')[0] || 'Imported User';

    // Determine role
    const role = data.role || UserRole.EMPLOYEE;

    // Create user
    const user = new User({
      email,
      passwordHash,
      name,
      phone: data.phone?.trim() || undefined,
      role,
      roles: data.roles ? data.roles.filter(r => r && r !== data.role) : [], // Additional roles (excluding primary role)
      status: data.status || UserStatus.ACTIVE,
      companyId: data.companyId ? new mongoose.Types.ObjectId(data.companyId) : undefined,
      managerId: data.managerId ? new mongoose.Types.ObjectId(data.managerId) : undefined,
      departmentId: data.departmentId ? new mongoose.Types.ObjectId(data.departmentId) : undefined,
      employeeId: data.employeeId?.trim() || undefined,
    });

    // Auto-generate unique employee ID if:
    // 1. User is not SUPER_ADMIN
    // 2. employeeId is not already provided
    // 3. User has a companyId
    if (
      role !== UserRole.SUPER_ADMIN &&
      !data.employeeId &&
      data.companyId
    ) {
      try {
        const { EmployeeIdService } = await import('./employeeId.service');
        const generatedId = await EmployeeIdService.generateUniqueEmployeeId(
          data.companyId,
          data.departmentId || null,
          undefined
        );
        user.employeeId = generatedId;
        logger.info(`Auto-generated employee ID ${generatedId} for new user ${email}`);
      } catch (error: any) {
        // Log error but don't fail user creation
        logger.error({ error }, 'Failed to auto-generate employee ID, continuing without it');
      }
    }

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

        // Enqueue analytics snapshot refresh for company admin
        enqueueAnalyticsEvent({ companyId, event: 'REBUILD_SNAPSHOT' });

        // Update super admin dashboard analytics in real-time
        try {
          await SystemAnalyticsService.collectAndEmitDashboardAnalytics();
        } catch (analyticsError) {
          logger.warn({ error: analyticsError }, 'Failed to update super admin dashboard analytics after user creation');
        }
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

    if (data.roles !== undefined) {
      // Filter out duplicates and the primary role
      const primaryRole = data.role !== undefined ? data.role : user.role;
      const additionalRoles = data.roles.filter(r => r && r !== primaryRole);
      user.roles = additionalRoles.map(role => new mongoose.Types.ObjectId(role));
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

        // Enqueue analytics snapshot refresh
        enqueueAnalyticsEvent({ companyId, event: 'REBUILD_SNAPSHOT' });
      } catch (error) {
        // Don't fail user update if real-time updates fail
        logger.error({ error }, 'Error emitting real-time updates');
      }
    }

    return updatedUser;
  }

  static async bulkAction(
    userIds: string[],
    action: 'activate' | 'deactivate' | 'delete',
    requestingUserId: string,
    companyId?: string
  ): Promise<{ success: boolean; updated: number; failed: number; errors: string[] }> {
    if (!userIds || userIds.length === 0) {
      throw new Error('No user IDs provided');
    }

    let updated = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const userId of userIds) {
      try {
        const user = await User.findById(userId);

        if (!user) {
          failed++;
          errors.push(`User ${userId} not found`);
          continue;
        }

        // Verify user belongs to same company if companyId is provided
        if (companyId && user.companyId?.toString() !== companyId) {
          failed++;
          errors.push(`User ${userId} does not belong to your company`);
          continue;
        }

        // Perform action
        switch (action) {
          case 'activate':
            user.status = UserStatus.ACTIVE;
            await user.save();
            await AuditService.log(requestingUserId, 'User', userId, AuditAction.UPDATE);
            updated++;
            break;

          case 'deactivate':
            user.status = UserStatus.INACTIVE;
            await user.save();
            await AuditService.log(requestingUserId, 'User', userId, AuditAction.UPDATE);
            updated++;
            break;

          case 'delete':
            // Permanent delete: remove user from database
            await user.deleteOne();
            await AuditService.log(requestingUserId, 'User', userId, AuditAction.DELETE);
            updated++;
            break;

          default:
            failed++;
            errors.push(`Invalid action: ${action}`);
        }

        // Emit real-time updates if user has a company
        if (user.companyId) {
          try {
            const userCompanyId = user.companyId.toString();
            const formattedUser = {
              id: user._id?.toString(),
              _id: user._id?.toString(),
              name: user.name,
              email: user.email,
              phone: user.phone,
              role: user.role,
              status: user.status,
              companyId: user.companyId,
            };
            emitUserUpdated(userCompanyId, formattedUser);
          } catch (error) {
            // Don't fail bulk action if real-time updates fail
            logger.error({ error, userId }, 'Error emitting real-time update for bulk action');
          }
        }
      } catch (error: any) {
        failed++;
        errors.push(`Error processing user ${userId}: ${error.message || 'Unknown error'}`);
        logger.error({ error, userId, action }, 'Error in bulk action');
      }
    }

    // Enqueue analytics snapshot refresh for company if applicable
    if (companyId && updated > 0) {
      try {
        enqueueAnalyticsEvent({ companyId, event: 'REBUILD_SNAPSHOT' });
      } catch (error) {
        logger.error({ error, companyId }, 'Error enqueueing analytics update after bulk action');
      }
    }

    return {
      success: failed === 0,
      updated,
      failed,
      errors,
    };
  }
}


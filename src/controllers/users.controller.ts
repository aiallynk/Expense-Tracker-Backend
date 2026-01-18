import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { UsersService } from '../services/users.service';
import { updateProfileSchema, createUserSchema, updateUserSchema, bulkUserActionSchema } from '../utils/dtoTypes';
import { UserRole, UserStatus } from '../utils/enums';
import { uploadToS3, getProfileImageKey, getObjectUrl } from '../utils/s3';
import { AuditService } from '../services/audit.service';
import { AuditAction } from '../utils/enums';
import { logger } from '@/config/logger';

export class UsersController {
  static getMe = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await UsersService.getCurrentUser(req.user!.id, req.user!.role);

    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    // Return user data with the role from the token (selected role), not the primary role
    const userData = user.toObject ? user.toObject() : user;
    const responseData = {
      ...userData,
      role: req.user!.role, // Use role from token (selected role)
      id: req.user!.id,
      email: req.user!.email,
    };

    res.status(200).json({
      success: true,
      data: responseData,
    });
  });

  static updateProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateProfileSchema.parse(req.body);
    const user = await UsersService.updateProfile(req.user!.id, data, req.user!.role);

    res.status(200).json({
      success: true,
      data: user,
    });
  });

  static getCompanies = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const { Company, CompanyStatus } = await import('../models/Company');
    // CompanyStatus.ACTIVE is 'active' (lowercase)
    const companies = await Company.find({ status: CompanyStatus.ACTIVE })
      .select('name domain')
      .sort({ name: 1 })
      .exec();

    res.status(200).json({
      success: true,
      data: companies,
    });
  });

  static getAllUsers = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    let companyId: string | undefined;
    let excludeAdminRoles = false;

    // If user is COMPANY_ADMIN, filter by their companyId and exclude admin roles
    if (requestingUser.role === 'COMPANY_ADMIN') {
      // Get company admin details to get companyId
      const { CompanyAdmin } = await import('../models/CompanyAdmin');
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
      // Exclude admin roles - only show EMPLOYEE, MANAGER, BUSINESS_HEAD, ACCOUNTANT
      excludeAdminRoles = true;
    }

    const filters = {
      role: req.query.role as string | undefined,
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      pageSize: req.query.pageSize
        ? parseInt(req.query.pageSize as string, 10)
        : undefined,
      companyId,
      departmentId: req.query.departmentId as string | undefined,
      excludeAdminRoles,
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

  static createUser = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    const data = createUserSchema.parse(req.body);
    
    // Map role to enum
    const role = data.role as UserRole;
    const status = (data.status || UserStatus.ACTIVE) as UserStatus;

    let companyId = data.companyId;

    // If user is COMPANY_ADMIN, use their companyId and ensure role is not admin
    if (requestingUser.role === 'COMPANY_ADMIN' || requestingUser.role === UserRole.COMPANY_ADMIN) {
      // Get company admin details to get companyId
      const { CompanyAdmin } = await import('../models/CompanyAdmin');
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      } else if (requestingUser.companyId) {
        // Fallback to companyId from JWT token if available
        companyId = requestingUser.companyId;
      }
      
      // Ensure COMPANY_ADMIN cannot create admin roles - only EMPLOYEE, MANAGER, BUSINESS_HEAD, ACCOUNTANT
      if (![UserRole.EMPLOYEE, UserRole.MANAGER, UserRole.BUSINESS_HEAD, UserRole.ACCOUNTANT].includes(role)) {
        res.status(403).json({
          success: false,
          message: 'Company admins can only create users with EMPLOYEE, MANAGER, BUSINESS_HEAD, or ACCOUNTANT roles',
          code: 'INVALID_ROLE',
        });
        return;
      }
    }

    const user = await UsersService.createUser({
      email: data.email,
      password: data.password,
      name: data.name,
      phone: data.phone,
      role,
      roles: data.roles, // Additional roles array
      companyId,
      managerId: data.managerId,
      departmentId: data.departmentId,
      status,
      employeeId: data.employeeId,
    });

    res.status(201).json({
      success: true,
      data: user,
      message: 'User created successfully',
    });
  });

  static updateUser = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    const userId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const data = updateUserSchema.parse(req.body);

    const user = await UsersService.updateUser(
      userId,
      data,
      requestingUser.id,
      requestingUser.role
    );

    res.status(200).json({
      success: true,
      data: user,
      message: 'User updated successfully',
    });
  });

  static getUserById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    const userId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    
    let companyId: string | undefined;
    
    // If user is COMPANY_ADMIN, ensure they can only view users in their company
    if (requestingUser.role === 'COMPANY_ADMIN') {
      const { CompanyAdmin } = await import('../models/CompanyAdmin');
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    }

    const user = await UsersService.getUserById(userId, companyId);

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

  static bulkAction = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    const data = bulkUserActionSchema.parse(req.body);
    
    let companyId: string | undefined;
    
    // If user is COMPANY_ADMIN, get their companyId
    if (requestingUser.role === 'COMPANY_ADMIN') {
      const { CompanyAdmin } = await import('../models/CompanyAdmin');
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (requestingUser.companyId) {
      companyId = requestingUser.companyId;
    }

    const result = await UsersService.bulkAction(
      data.userIds,
      data.action,
      requestingUser.id,
      companyId
    );

    res.status(200).json({
      success: result.success,
      data: {
        updated: result.updated,
        failed: result.failed,
        errors: result.errors,
      },
      message: result.success
        ? `Successfully ${data.action}d ${result.updated} user(s)`
        : `${result.updated} user(s) ${data.action}d, ${result.failed} failed`,
    });
  });

  static uploadProfileImage = asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    
    // Get file from multer (if using multer middleware) or from request body
    let fileBuffer: Buffer;
    let mimeType: string;

    if ((req as any).file) {
      // Multer middleware was used
      const file = (req as any).file;
      fileBuffer = file.buffer;
      mimeType = file.mimetype;
    } else if (req.body instanceof Buffer) {
      // Raw binary upload
      fileBuffer = req.body;
      mimeType = (req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    } else {
      res.status(400).json({
        success: false,
        message: 'No file provided',
        code: 'NO_FILE',
      });
      return;
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (fileBuffer.length > maxSize) {
      res.status(400).json({
        success: false,
        message: 'File size exceeds 5MB limit',
        code: 'FILE_TOO_LARGE',
      });
      return;
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
    if (!allowedTypes.includes(mimeType)) {
      res.status(400).json({
        success: false,
        message: 'Invalid file type. Allowed types: jpg, jpeg, png',
        code: 'INVALID_FILE_TYPE',
      });
      return;
    }

    // Get user to get companyId
    const user = await UsersService.getCurrentUser(userId, userRole);
    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    const userObj = user.toObject ? user.toObject() : user;
    const companyId = (userObj.companyId as any)?._id?.toString() || (userObj.companyId as any)?.toString() || 'default';

    // Determine file extension
    const extension = mimeType === 'image/png' ? 'png' : 'jpg';

    // Generate S3 key
    const storageKey = getProfileImageKey(companyId, userId, extension);

    // Delete old profile image if exists
    if (userObj.profileImage) {
      try {
        // Extract key from URL or use the old key
        const oldKey = userObj.profileImage.includes('/') 
          ? userObj.profileImage.split('.com/')[1] 
          : userObj.profileImage;
        
        // Note: We don't delete the old file immediately to avoid issues
        // Old files can be cleaned up by a scheduled job
        logger.info({ userId, oldKey }, 'Old profile image exists, will be replaced');
      } catch (error) {
        logger.warn({ error, userId }, 'Error processing old profile image');
      }
    }

    // Upload to S3
    await uploadToS3('receipts', storageKey, fileBuffer, mimeType);

    // Get S3 URL
    const profileImageUrl = getObjectUrl('receipts', storageKey);

    // Update user record
    const updatedUser = await UsersService.updateProfile(
      userId,
      { profileImage: profileImageUrl } as any,
      userRole
    );

    // Audit log
    await AuditService.log(
      userId,
      userRole === 'COMPANY_ADMIN' ? 'CompanyAdmin' : 'User',
      userId,
      AuditAction.UPDATE,
      { action: 'profile_image_upload' }
    );

    logger.info({ userId, storageKey }, 'User updated profile image');

    res.status(200).json({
      success: true,
      data: {
        profileImage: profileImageUrl,
        user: updatedUser,
      },
      message: 'Profile image uploaded successfully',
    });
  });
}


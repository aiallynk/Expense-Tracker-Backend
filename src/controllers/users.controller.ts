import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { UsersService } from '../services/users.service';
import { updateProfileSchema, createUserSchema, updateUserSchema } from '../utils/dtoTypes';
import { UserRole, UserStatus } from '../utils/enums';

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

    res.status(200).json({
      success: true,
      data: user,
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
      // Exclude admin roles - only show EMPLOYEE, MANAGER, BUSINESS_HEAD
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
    if (requestingUser.role === 'COMPANY_ADMIN') {
      // Get company admin details to get companyId
      const { CompanyAdmin } = await import('../models/CompanyAdmin');
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
      
      // Ensure COMPANY_ADMIN cannot create admin roles - only EMPLOYEE, MANAGER, BUSINESS_HEAD
      if (![UserRole.EMPLOYEE, UserRole.MANAGER, UserRole.BUSINESS_HEAD].includes(role)) {
        res.status(403).json({
          success: false,
          message: 'Company admins can only create users with EMPLOYEE, MANAGER, or BUSINESS_HEAD roles',
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
      companyId,
      managerId: data.managerId,
      departmentId: data.departmentId,
      status,
    });

    res.status(201).json({
      success: true,
      data: user,
      message: 'User created successfully',
    });
  });

  static updateUser = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    const userId = req.params.id;
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
    const userId = req.params.id;
    
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
}


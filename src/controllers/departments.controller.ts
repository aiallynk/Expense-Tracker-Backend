import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { DepartmentStatus } from '../models/Department';
import { DepartmentsService } from '../services/departments.service';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
} from '../utils/dtoTypes';


export class DepartmentsController {
  // Get all departments for company admin's company
  static getAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    let companyId: string | undefined;

    // Allow companyId from query parameter for users without company (registration)
    if (req.query.companyId) {
      companyId = req.query.companyId as string;
    } else if (requestingUser.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (requestingUser.role === 'SUPER_ADMIN' && req.query.companyId) {
      companyId = req.query.companyId as string;
    } else if (requestingUser.companyId) {
      companyId = requestingUser.companyId.toString();
    }

    if (!companyId) {
      res.status(403).json({
        success: false,
        message: 'Company ID is required',
        code: 'COMPANY_ID_REQUIRED',
      });
      return;
    }

    const status = req.query.status as DepartmentStatus | undefined;
    const isCustom = req.query.isCustom === 'true' ? true : req.query.isCustom === 'false' ? false : undefined;

    const departments = await DepartmentsService.getAllDepartments(companyId, { status, isCustom });

    res.status(200).json({
      success: true,
      data: departments,
    });
  });

  // Get department by ID
  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    let companyId: string | undefined;

    if (requestingUser.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (requestingUser.companyId) {
      companyId = requestingUser.companyId.toString();
    }

    if (!companyId) {
      res.status(403).json({
        success: false,
        message: 'Company ID is required',
        code: 'COMPANY_ID_REQUIRED',
      });
      return;
    }

    const departmentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const department = await DepartmentsService.getDepartmentById(departmentId, companyId);

    if (!department) {
      res.status(404).json({
        success: false,
        message: 'Department not found',
        code: 'DEPARTMENT_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: department,
    });
  });

  // Create department
  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    let companyId: string | undefined;

    if (requestingUser.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (requestingUser.companyId) {
      companyId = requestingUser.companyId.toString();
    }

    if (!companyId) {
      res.status(403).json({
        success: false,
        message: 'Company ID is required',
        code: 'COMPANY_ID_REQUIRED',
      });
      return;
    }

    const data = createDepartmentSchema.parse(req.body);

    try {
      const department = await DepartmentsService.createDepartment(companyId, {
        name: data.name,
        code: data.code,
        description: data.description,
        status: data.status as DepartmentStatus | undefined,
        isCustom: true, // User-created departments are always custom
        headId: data.headId,
      });

      res.status(201).json({
        success: true,
        data: department,
        message: 'Department created successfully',
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to create department',
        code: 'DEPARTMENT_CREATE_ERROR',
      });
    }
  });

  // Update department
  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    let companyId: string | undefined;

    if (requestingUser.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (requestingUser.companyId) {
      companyId = requestingUser.companyId.toString();
    }

    if (!companyId) {
      res.status(403).json({
        success: false,
        message: 'Company ID is required',
        code: 'COMPANY_ID_REQUIRED',
      });
      return;
    }

    const data = updateDepartmentSchema.parse(req.body);

    try {
      const updateData: {
        name?: string;
        code?: string;
        description?: string;
        status?: DepartmentStatus;
        headId?: string;
      } = {
        ...(data.name && { name: data.name }),
        ...(data.code && { code: data.code }),
        ...(data.description && { description: data.description }),
        ...(data.status && { status: data.status as DepartmentStatus }),
        ...(data.headId && { headId: data.headId }),
      };
      const departmentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const department = await DepartmentsService.updateDepartment(
        departmentId,
        companyId,
        updateData
      );

      if (!department) {
        res.status(404).json({
          success: false,
          message: 'Department not found',
          code: 'DEPARTMENT_NOT_FOUND',
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: department,
        message: 'Department updated successfully',
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to update department',
        code: 'DEPARTMENT_UPDATE_ERROR',
      });
    }
  });

  // Delete department
  static delete = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    let companyId: string | undefined;

    if (requestingUser.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (requestingUser.companyId) {
      companyId = requestingUser.companyId.toString();
    }

    if (!companyId) {
      res.status(403).json({
        success: false,
        message: 'Company ID is required',
        code: 'COMPANY_ID_REQUIRED',
      });
      return;
    }

    const departmentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deleted = await DepartmentsService.deleteDepartment(departmentId, companyId);

    if (!deleted) {
      res.status(404).json({
        success: false,
        message: 'Department not found or cannot be deleted',
        code: 'DEPARTMENT_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Department deleted successfully',
    });
  });

  // Initialize default departments
  static initializeDefaults = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    let companyId: string | undefined;

    if (requestingUser.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (requestingUser.companyId) {
      companyId = requestingUser.companyId.toString();
    }

    if (!companyId) {
      res.status(403).json({
        success: false,
        message: 'Company ID is required',
        code: 'COMPANY_ID_REQUIRED',
      });
      return;
    }

    const departments = await DepartmentsService.initializeDefaultDepartments(companyId);

    res.status(200).json({
      success: true,
      data: departments,
      message: 'Default departments initialized successfully',
    });
  });
}


import bcrypt from 'bcrypt';
import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { Company } from '../models/Company';
import { CompanyAdmin, CompanyAdminStatus } from '../models/CompanyAdmin';
import { AuditService } from '../services/audit.service';
import { AuditAction } from '../utils/enums';

export class CompanyAdminController {
  /**
   * Create a new company admin for a specific company
   * POST /api/v1/companies/:companyId/admins
   */
  static createCompanyAdmin = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] : req.params.companyId;
    const { email, name, password } = req.body;

    // Validate company ID
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid company ID format',
        code: 'INVALID_ID',
      });
      return;
    }

    // Validate required fields
    if (!email || !name || !password) {
      res.status(400).json({
        success: false,
        message: 'Email, name, and password are required',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // Validate password length
    if (password.length < 6) {
      res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // Check if company exists
    const company = await Company.findById(companyId);
    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    // Check if company admin already exists
    const existingAdmin = await CompanyAdmin.findOne({ email: email.toLowerCase().trim() });
    if (existingAdmin) {
      res.status(409).json({
        success: false,
        message: 'Company admin with this email already exists',
        code: 'ADMIN_ALREADY_EXISTS',
      });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create company admin
    const companyAdmin = new CompanyAdmin({
      email: email.toLowerCase().trim(),
      passwordHash,
      name: name.trim(),
      companyId: new mongoose.Types.ObjectId(companyId),
      status: CompanyAdminStatus.ACTIVE,
    });

    await companyAdmin.save();

    // Log audit
    await AuditService.log(
      req.user!.id,
      'CompanyAdmin',
      (companyAdmin._id as mongoose.Types.ObjectId).toString(),
      AuditAction.CREATE,
      { companyId }
    );

    res.status(201).json({
      success: true,
      message: 'Company admin created successfully',
      data: {
        id: (companyAdmin._id as mongoose.Types.ObjectId).toString(),
        name: companyAdmin.name,
        email: companyAdmin.email,
        companyId,
        status: companyAdmin.status,
        createdAt: companyAdmin.createdAt,
      },
    });
  });

  /**
   * Get all company admins for a specific company
   * GET /api/v1/companies/:companyId/admins
   */
  static getCompanyAdmins = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] : req.params.companyId;

    // Validate company ID
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid company ID format',
        code: 'INVALID_ID',
      });
      return;
    }

    // Check if company exists
    const company = await Company.findById(companyId);
    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    // Get all company admins for this company
    const admins = await CompanyAdmin.find({
      companyId: new mongoose.Types.ObjectId(companyId),
    })
      .select('email name status createdAt lastLoginAt')
      .sort({ createdAt: -1 })
      .lean();

    const formattedAdmins = admins.map((admin) => ({
      id: admin._id.toString(),
      name: admin.name || 'Unknown',
      email: admin.email,
      status: admin.status,
      createdAt: admin.createdAt,
      lastLogin: admin.lastLoginAt ? admin.lastLoginAt.toISOString() : null,
    }));

    res.status(200).json({
      success: true,
      data: {
        admins: formattedAdmins,
        count: formattedAdmins.length,
      },
    });
  });

  /**
   * Get a specific company admin by ID
   * GET /api/v1/companies/:companyId/admins/:adminId
   */
  static getCompanyAdminById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] : req.params.companyId;
    const adminId = Array.isArray(req.params.adminId) ? req.params.adminId[0] : req.params.adminId;

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(companyId) || !mongoose.Types.ObjectId.isValid(adminId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid ID format',
        code: 'INVALID_ID',
      });
      return;
    }

    // Check if company exists
    const company = await Company.findById(companyId);
    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    // Get company admin
    const admin = await CompanyAdmin.findOne({
      _id: new mongoose.Types.ObjectId(adminId),
      companyId: new mongoose.Types.ObjectId(companyId),
    })
      .select('email name status createdAt lastLoginAt companyId')
      .lean();

    if (!admin) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found',
        code: 'ADMIN_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        id: admin._id.toString(),
        name: admin.name || 'Unknown',
        email: admin.email,
        status: admin.status,
        createdAt: admin.createdAt,
        lastLogin: admin.lastLoginAt ? admin.lastLoginAt.toISOString() : null,
        companyId: admin.companyId?.toString(),
      },
    });
  });

  /**
   * Update a company admin
   * PUT /api/v1/companies/:companyId/admins/:adminId
   */
  static updateCompanyAdmin = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] : req.params.companyId;
    const adminId = Array.isArray(req.params.adminId) ? req.params.adminId[0] : req.params.adminId;
    const { name, status } = req.body;

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(companyId) || !mongoose.Types.ObjectId.isValid(adminId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid ID format',
        code: 'INVALID_ID',
      });
      return;
    }

    // Check if company exists
    const company = await Company.findById(companyId);
    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    // Find and update company admin
    const admin = await CompanyAdmin.findOne({
      _id: new mongoose.Types.ObjectId(adminId),
      companyId: new mongoose.Types.ObjectId(companyId),
    });

    if (!admin) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found',
        code: 'ADMIN_NOT_FOUND',
      });
      return;
    }

    // Update fields
    if (name !== undefined) {
      admin.name = name.trim();
    }
    if (status !== undefined) {
      if (status === 'active' || status === 'inactive' || status === 'suspended') {
        admin.status = status as CompanyAdminStatus;
      } else {
        res.status(400).json({
          success: false,
          message: 'Invalid status. Must be "active", "inactive", or "suspended"',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
    }

    await admin.save();

    // Log audit
    await AuditService.log(
      req.user!.id,
      'CompanyAdmin',
      adminId,
      AuditAction.UPDATE,
      { companyId, changes: { name, status } }
    );

    res.status(200).json({
      success: true,
      message: 'Company admin updated successfully',
      data: {
        id: (admin._id as mongoose.Types.ObjectId).toString(),
        name: admin.name,
        email: admin.email,
        status: admin.status,
        updatedAt: admin.updatedAt,
      },
    });
  });

  /**
   * Delete a company admin
   * DELETE /api/v1/companies/:companyId/admins/:adminId
   */
  static deleteCompanyAdmin = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] : req.params.companyId;
    const adminId = Array.isArray(req.params.adminId) ? req.params.adminId[0] : req.params.adminId;

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(companyId) || !mongoose.Types.ObjectId.isValid(adminId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid ID format',
        code: 'INVALID_ID',
      });
      return;
    }

    // Check if company exists
    const company = await Company.findById(companyId);
    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    // Find and delete company admin
    const admin = await CompanyAdmin.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(adminId),
      companyId: new mongoose.Types.ObjectId(companyId),
    });

    if (!admin) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found',
        code: 'ADMIN_NOT_FOUND',
      });
      return;
    }

    // Log audit
    await AuditService.log(
      req.user!.id,
      'CompanyAdmin',
      adminId,
      AuditAction.DELETE,
      { companyId }
    );

    res.status(200).json({
      success: true,
      message: 'Company admin deleted successfully',
    });
  });

  /**
   * Reset company admin password
   * POST /api/v1/companies/:companyId/admins/:adminId/reset-password
   */
  static resetCompanyAdminPassword = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] : req.params.companyId;
    const adminId = Array.isArray(req.params.adminId) ? req.params.adminId[0] : req.params.adminId;
    const { newPassword } = req.body;

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(companyId) || !mongoose.Types.ObjectId.isValid(adminId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid ID format',
        code: 'INVALID_ID',
      });
      return;
    }

    // Validate password
    if (!newPassword || newPassword.length < 6) {
      res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // Check if company exists
    const company = await Company.findById(companyId);
    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    // Find company admin
    const admin = await CompanyAdmin.findOne({
      _id: new mongoose.Types.ObjectId(adminId),
      companyId: new mongoose.Types.ObjectId(companyId),
    });

    if (!admin) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found',
        code: 'ADMIN_NOT_FOUND',
      });
      return;
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);
    admin.passwordHash = passwordHash;
    await admin.save();

    // Log audit
    await AuditService.log(
      req.user!.id,
      'CompanyAdmin',
      adminId,
      AuditAction.UPDATE,
      { companyId, action: 'password_reset' }
    );

    res.status(200).json({
      success: true,
      message: 'Password reset successfully',
    });
  });
}


import { Response } from 'express';
import { z } from 'zod';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ServiceAccountService } from '../services/serviceAccount.service';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { User } from '../models/User';

// Validation schemas
const createServiceAccountSchema = z.object({
  name: z.string().min(1).max(100),
  companyId: z.string().optional(),
  allowedEndpoints: z.array(z.string()).min(1),
  expiresAt: z
    .union([z.string().datetime(), z.date()])
    .optional()
    .transform((val) => (val ? (typeof val === 'string' ? new Date(val) : val) : undefined)),
});

const updateServiceAccountSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  allowedEndpoints: z.array(z.string()).min(1).optional(),
  expiresAt: z
    .union([z.string().datetime(), z.date()])
    .optional()
    .transform((val) => (val ? (typeof val === 'string' ? new Date(val) : val) : undefined)),
});

export class ServiceAccountController {
  /**
   * Create a new service account
   * POST /api/v1/service-accounts
   */
  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createServiceAccountSchema.parse(req.body);
    const userId = req.user!.id;

    // Get company ID from user if not provided
    let companyId: string | undefined = data.companyId;

    // If user is COMPANY_ADMIN, use their company
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(userId)
        .select('companyId')
        .exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = (companyAdmin.companyId as any).toString();
      }
    } else if (req.user!.role !== 'SUPER_ADMIN') {
      // Regular users get company from their user record
      const user = await User.findById(userId).select('companyId').exec();
      if (user && user.companyId) {
        companyId = (user.companyId as any).toString();
      }
    }

    const result = await ServiceAccountService.createServiceAccount(
      {
        ...data,
        companyId,
      },
      userId
    );

    res.status(201).json({
      success: true,
      message: 'Service account created successfully',
      data: {
        serviceAccount: result.serviceAccount,
        apiKey: result.apiKey, // Return API key ONLY ONCE
        warning: 'Save this API key now. It will not be shown again.',
      },
    });
  });

  /**
   * List service accounts
   * GET /api/v1/service-accounts
   */
  static list = asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    let companyId: string | undefined;

    // Get company ID based on user role
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(userId)
        .select('companyId')
        .exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = (companyAdmin.companyId as any).toString();
      }
    } else if (req.user!.role !== 'SUPER_ADMIN') {
      const user = await User.findById(userId).select('companyId').exec();
      if (user && user.companyId) {
        companyId = (user.companyId as any).toString();
      }
    }

    const serviceAccounts = await ServiceAccountService.listServiceAccounts(
      companyId
    );

    res.status(200).json({
      success: true,
      data: serviceAccounts,
    });
  });

  /**
   * Get service account by ID
   * GET /api/v1/service-accounts/:id
   */
  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;
    let companyId: string | undefined;

    // Get company ID based on user role
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(userId)
        .select('companyId')
        .exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = (companyAdmin.companyId as any).toString();
      }
    } else if (req.user!.role !== 'SUPER_ADMIN') {
      const user = await User.findById(userId).select('companyId').exec();
      if (user && user.companyId) {
        companyId = (user.companyId as any).toString();
      }
    }

    const serviceAccount = await ServiceAccountService.getServiceAccountById(
      id,
      companyId
    );

    if (!serviceAccount) {
      res.status(404).json({
        success: false,
        message: 'Service account not found',
        code: 'NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: serviceAccount,
    });
  });

  /**
   * Update service account
   * PATCH /api/v1/service-accounts/:id
   */
  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const data = updateServiceAccountSchema.parse(req.body);
    const userId = req.user!.id;
    let companyId: string | undefined;

    // Get company ID based on user role
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(userId)
        .select('companyId')
        .exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = (companyAdmin.companyId as any).toString();
      }
    } else if (req.user!.role !== 'SUPER_ADMIN') {
      const user = await User.findById(userId).select('companyId').exec();
      if (user && user.companyId) {
        companyId = (user.companyId as any).toString();
      }
    }

    const serviceAccount = await ServiceAccountService.updateServiceAccount(
      id,
      data,
      userId,
      companyId
    );

    res.status(200).json({
      success: true,
      message: 'Service account updated successfully',
      data: serviceAccount,
    });
  });

  /**
   * Regenerate API key
   * POST /api/v1/service-accounts/:id/regenerate-key
   */
  static regenerateKey = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;
    let companyId: string | undefined;

    // Get company ID based on user role
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(userId)
        .select('companyId')
        .exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = (companyAdmin.companyId as any).toString();
      }
    } else if (req.user!.role !== 'SUPER_ADMIN') {
      const user = await User.findById(userId).select('companyId').exec();
      if (user && user.companyId) {
        companyId = (user.companyId as any).toString();
      }
    }

    const result = await ServiceAccountService.regenerateApiKey(
      id,
      userId,
      companyId
    );

    res.status(200).json({
      success: true,
      message: 'API key regenerated successfully',
      data: {
        serviceAccount: result.serviceAccount,
        apiKey: result.apiKey, // Return new API key ONLY ONCE
        warning: 'Save this API key now. The old key is now invalid.',
      },
    });
  });

  /**
   * Delete (revoke) service account
   * DELETE /api/v1/service-accounts/:id
   */
  static delete = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;
    let companyId: string | undefined;

    // Get company ID based on user role
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(userId)
        .select('companyId')
        .exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = (companyAdmin.companyId as any).toString();
      }
    } else if (req.user!.role !== 'SUPER_ADMIN') {
      const user = await User.findById(userId).select('companyId').exec();
      if (user && user.companyId) {
        companyId = (user.companyId as any).toString();
      }
    }

    await ServiceAccountService.deleteServiceAccount(id, userId, companyId);

    res.status(200).json({
      success: true,
      message: 'Service account revoked successfully',
    });
  });
}


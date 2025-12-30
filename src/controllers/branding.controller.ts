import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { BrandingService } from '../services/branding.service';
import { uploadIntentSchema } from '../utils/dtoTypes';

export class BrandingController {
  /**
   * Create upload intent for company logo
   * POST /api/v1/company-admin/branding/logo/upload-intent
   */
  static createUploadIntent = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
    
    if (!companyAdmin || !companyAdmin.companyId) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found or company not associated',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const data = uploadIntentSchema.parse(req.body);
    const companyId = companyAdmin.companyId.toString();
    const result = await BrandingService.createUploadIntent(companyId, data);

    res.status(200).json({
      success: true,
      data: {
        uploadUrl: result.uploadUrl,
        storageKey: result.storageKey,
        expiresIn: 3600,
      },
    });
  });

  /**
   * Confirm logo upload
   * POST /api/v1/company-admin/branding/logo/confirm-upload
   */
  static confirmUpload = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
    
    if (!companyAdmin || !companyAdmin.companyId) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found or company not associated',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const { storageKey } = req.body;
    if (!storageKey) {
      res.status(400).json({
        success: false,
        message: 'Storage key is required',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const companyId = companyAdmin.companyId.toString();
    const result = await BrandingService.confirmUpload(companyId, storageKey);

    res.status(200).json({
      success: true,
      message: 'Logo uploaded successfully',
      data: {
        logoUrl: result.logoUrl,
        logoStorageKey: result.logoStorageKey,
      },
    });
  });

  /**
   * Get company logo URL (for any authenticated user)
   * GET /api/v1/branding/logo
   */
  static getLogo = asyncHandler(async (req: AuthRequest, res: Response) => {
    let companyId: string | undefined;

    // Try to get company ID from user
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else {
      // For regular users, get company from user record
      const { User } = await import('../models/User');
      const user = await User.findById(req.user!.id).select('companyId').exec();
      if (user && user.companyId) {
        companyId = (user.companyId as any)._id?.toString() || user.companyId.toString();
      }
    }

    if (!companyId) {
      res.status(404).json({
        success: false,
        message: 'Company not found or user not associated with a company',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const logoUrl = await BrandingService.getLogoUrl(companyId);

    res.status(200).json({
      success: true,
      data: {
        logoUrl,
      },
    });
  });

  /**
   * Delete company logo
   * DELETE /api/v1/company-admin/branding/logo
   */
  static deleteLogo = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
    
    if (!companyAdmin || !companyAdmin.companyId) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found or company not associated',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const companyId = companyAdmin.companyId.toString();
    await BrandingService.deleteLogo(companyId);

    res.status(200).json({
      success: true,
      message: 'Logo deleted successfully',
    });
  });
}


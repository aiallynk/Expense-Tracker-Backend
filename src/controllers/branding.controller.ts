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
   * Body: { filename, mimeType, sizeBytes, mode?: 'light' | 'dark' }
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
    const mode = (req.body.mode === 'dark' ? 'dark' : 'light') as 'light' | 'dark';
    const companyId = companyAdmin.companyId.toString();
    const result = await BrandingService.createUploadIntent(companyId, data, mode);

    res.status(200).json({
      success: true,
      data: {
        uploadUrl: result.uploadUrl,
        storageKey: result.storageKey,
        expiresIn: 3600,
        mode,
      },
    });
  });

  /**
   * Confirm logo upload
   * POST /api/v1/company-admin/branding/logo/confirm-upload
   * Body: { storageKey, mode?: 'light' | 'dark' }
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

    const { storageKey, mode } = req.body;
    if (!storageKey) {
      res.status(400).json({
        success: false,
        message: 'Storage key is required',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const logoMode = (mode === 'dark' ? 'dark' : 'light') as 'light' | 'dark';
    const companyId = companyAdmin.companyId.toString();
    const result = await BrandingService.confirmUpload(companyId, storageKey, logoMode);

    res.status(200).json({
      success: true,
      message: 'Logo uploaded successfully',
      data: {
        logoUrl: result.logoUrl,
        logoStorageKey: result.logoStorageKey,
        mode: logoMode,
      },
    });
  });

  /**
   * Get company logo URL (for any authenticated user)
   * GET /api/v1/branding/logo?mode=light|dark
   * Returns both logos if no mode specified
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
      // Return 200 with null logoUrl instead of 404 - not having a company/logo is a valid state
      res.status(200).json({
        success: true,
        data: {
          logoUrl: null,
          lightLogoUrl: null,
          darkLogoUrl: null,
        },
      });
      return;
    }

    const mode = req.query.mode as string | undefined;
    
    // If mode is specified, return single logo with fallback
    if (mode === 'dark' || mode === 'light') {
      const logoUrl = await BrandingService.getLogoUrl(companyId, mode as 'light' | 'dark', true);
      res.status(200).json({
        success: true,
        data: {
          logoUrl,
          mode,
        },
      });
      return;
    }

    // Otherwise, return both logos
    const logos = await BrandingService.getLogos(companyId);
    res.status(200).json({
      success: true,
      data: {
        lightLogoUrl: logos.lightLogoUrl,
        darkLogoUrl: logos.darkLogoUrl,
        // For backward compatibility, return light logo as logoUrl
        logoUrl: logos.lightLogoUrl,
      },
    });
  });

  /**
   * Delete company logo
   * DELETE /api/v1/company-admin/branding/logo?mode=light|dark
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

    const mode = (req.query.mode === 'dark' ? 'dark' : 'light') as 'light' | 'dark';
    const companyId = companyAdmin.companyId.toString();
    await BrandingService.deleteLogo(companyId, mode);

    res.status(200).json({
      success: true,
      message: `${mode === 'dark' ? 'Dark' : 'Light'} logo deleted successfully`,
      data: { mode },
    });
  });
}


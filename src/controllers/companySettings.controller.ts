import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { Company } from '../models/Company';
import { CompanySettingsService } from '../services/companySettings.service';
import { flushCompanyData } from '../services/flushData.service';

export class CompanySettingsController {
  /**
   * Get company settings
   * GET /api/v1/company-admin/settings
   */
  static getSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get company ID from company admin
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
    const settings = await CompanySettingsService.getSettingsByCompanyId(companyId);
    const settingsObj = settings.toObject();

    // If general.companyName is empty, use the main Company name so the Settings page shows and edits the canonical name
    if (!settingsObj.general?.companyName?.trim()) {
      const company = await Company.findById(companyId).select('name').lean().exec();
      if (company?.name) {
        settingsObj.general = settingsObj.general || {};
        settingsObj.general.companyName = company.name;
      }
    }

    // Fetch company roles for frontend (real-time roles)
    // Only return CUSTOM roles, exclude SYSTEM roles
    const { Role } = await import('../models/Role');
    const roles = await Role.find({ 
      companyId: companyAdmin.companyId, 
      isActive: true,
      type: 'CUSTOM' // Only custom/company roles, exclude system roles
    }).sort({ name: 1 }).exec();

    res.status(200).json({
      success: true,
      data: {
        ...settingsObj,
        roles, // Include roles in response for frontend
      },
    });
  });

  /**
   * Update company settings
   * PUT /api/v1/company-admin/settings
   */
  static updateSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get company ID from company admin
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
    const updates = req.body;

    // Validate required fields structure
    if (updates.approvalFlow && typeof updates.approvalFlow !== 'object') {
      res.status(400).json({
        success: false,
        message: 'Invalid approvalFlow settings format',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // Validate approvalMatrix if provided
    if (updates.approvalMatrix && typeof updates.approvalMatrix !== 'object') {
      res.status(400).json({
        success: false,
        message: 'Invalid approvalMatrix settings format',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    try {
      const settings = await CompanySettingsService.updateSettings(
        companyId,
        updates,
        req.user!.id
      );

      res.status(200).json({
        success: true,
        message: 'Settings updated successfully',
        data: settings,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message || 'Failed to update settings',
        code: 'VALIDATION_ERROR',
      });
      return;
    }
  });

  /**
   * Update self-approval policy
   * PUT /api/v1/company-admin/settings/self-approval
   * Body: { selfApprovalPolicy: 'SKIP_SELF' | 'ALLOW_SELF' }
   */
  static updateSelfApprovalPolicy = asyncHandler(async (req: AuthRequest, res: Response) => {
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
    const { selfApprovalPolicy } = req.body;
    if (!selfApprovalPolicy || (selfApprovalPolicy !== 'SKIP_SELF' && selfApprovalPolicy !== 'ALLOW_SELF')) {
      res.status(400).json({
        success: false,
        message: 'selfApprovalPolicy must be SKIP_SELF or ALLOW_SELF',
        code: 'VALIDATION_ERROR',
      });
      return;
    }
    const settings = await CompanySettingsService.updateSelfApprovalPolicy(companyId, selfApprovalPolicy, req.user!.id);
    res.status(200).json({
      success: true,
      message: 'Self-approval policy updated successfully',
      data: settings,
    });
  });

  /**
   * Reset company settings to default
   * POST /api/v1/company-admin/settings/reset
   */
  static resetSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get company ID from company admin
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
    const settings = await CompanySettingsService.resetSettings(companyId, req.user!.id);

    res.status(200).json({
      success: true,
      message: 'Settings reset to default successfully',
      data: settings,
    });
  });

  /**
   * Flush (permanently delete) company data by category.
   * POST /api/v1/company-admin/flush-data
   * Body: { flushAll?: boolean, flushExpenses?: boolean, flushReports?: boolean, flushUsers?: boolean }
   */
  static flushData = asyncHandler(async (req: AuthRequest, res: Response) => {
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
    const body = req.body as {
      flushAll?: boolean;
      flushExpenses?: boolean;
      flushReports?: boolean;
      flushUsers?: boolean;
    };
    const flushAll = Boolean(body.flushAll);
    const flushExpenses = flushAll || Boolean(body.flushExpenses);
    const flushReports = flushAll || Boolean(body.flushReports);
    const flushUsers = flushAll || Boolean(body.flushUsers);

    if (!flushExpenses && !flushReports && !flushUsers) {
      res.status(400).json({
        success: false,
        message: 'Select at least one option: expenses, reports, or users',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const result = await flushCompanyData({
      companyId,
      flushExpenses,
      flushReports,
      flushUsers,
    });

    res.status(200).json({
      success: true,
      message: 'Flush completed',
      data: result,
    });
  });
}


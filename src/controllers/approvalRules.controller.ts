import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ApprovalRulesService } from '../services/approvalRules.service';
import { CompanyAdmin } from '../models/CompanyAdmin';

export class ApprovalRulesController {
  /**
   * Get all approval rules for company
   * GET /api/v1/company-admin/approval-rules
   */
  static getApprovalRules = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get company ID from company admin
    const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
    
    if (!companyAdmin || !companyAdmin.companyId) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found or company not associated',
      });
      return;
    }

    const rules = await ApprovalRulesService.getApprovalRules(companyAdmin.companyId.toString());

    res.status(200).json({
      success: true,
      data: rules,
    });
  });

  /**
   * Create approval rule
   * POST /api/v1/company-admin/approval-rules
   */
  static createApprovalRule = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get company ID from company admin
    const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
    
    if (!companyAdmin || !companyAdmin.companyId) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found or company not associated',
      });
      return;
    }

    const rule = await ApprovalRulesService.createApprovalRule(
      companyAdmin.companyId.toString(),
      req.body
    );

    res.status(201).json({
      success: true,
      message: 'Approval rule created successfully',
      data: rule,
    });
  });

  /**
   * Update approval rule
   * PUT /api/v1/company-admin/approval-rules/:id
   */
  static updateApprovalRule = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get company ID from company admin
    const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
    
    if (!companyAdmin || !companyAdmin.companyId) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found or company not associated',
      });
      return;
    }

    const rule = await ApprovalRulesService.updateApprovalRule(
      req.params.id,
      companyAdmin.companyId.toString(),
      req.body
    );

    res.status(200).json({
      success: true,
      message: 'Approval rule updated successfully',
      data: rule,
    });
  });

  /**
   * Delete approval rule
   * DELETE /api/v1/company-admin/approval-rules/:id
   */
  static deleteApprovalRule = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get company ID from company admin
    const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
    
    if (!companyAdmin || !companyAdmin.companyId) {
      res.status(404).json({
        success: false,
        message: 'Company admin not found or company not associated',
      });
      return;
    }

    await ApprovalRulesService.deleteApprovalRule(
      req.params.id,
      companyAdmin.companyId.toString()
    );

    res.status(200).json({
      success: true,
      message: 'Approval rule deleted successfully',
    });
  });
}


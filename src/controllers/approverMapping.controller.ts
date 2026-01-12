import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { ApproverMappingService } from '../services/approverMapping.service';

export class ApproverMappingController {
  /**
   * Get all approver mappings for company
   * GET /api/v1/company-admin/approver-mappings
   */
  static getMappings = asyncHandler(async (req: AuthRequest, res: Response) => {
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
    const mappings = await ApproverMappingService.getMappingsByCompanyId(companyId);

    res.status(200).json({
      success: true,
      data: mappings,
    });
  });

  /**
   * Get approver mapping for a specific user
   * GET /api/v1/company-admin/approver-mappings/:userId
   */
  static getMappingByUserId = asyncHandler(async (req: AuthRequest, res: Response) => {
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
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const mapping = await ApproverMappingService.getMappingByUserId(userId, companyId);

    if (!mapping) {
      res.status(404).json({
        success: false,
        message: 'Approver mapping not found',
        code: 'MAPPING_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: mapping,
    });
  });

  /**
   * Create or update approver mapping
   * POST /api/v1/company-admin/approver-mappings
   */
  static upsertMapping = asyncHandler(async (req: AuthRequest, res: Response) => {
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
    const { userId, level1ApproverId, level2ApproverId, level3ApproverId, level4ApproverId, level5ApproverId } = req.body;

    if (!userId) {
      res.status(400).json({
        success: false,
        message: 'userId is required',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const mapping = await ApproverMappingService.upsertMapping(
      userId,
      companyId,
      {
        level1ApproverId,
        level2ApproverId,
        level3ApproverId,
        level4ApproverId,
        level5ApproverId,
      },
      req.user!.id
    );

    res.status(200).json({
      success: true,
      message: 'Approver mapping updated successfully',
      data: mapping,
    });
  });

  /**
   * Delete approver mapping
   * DELETE /api/v1/company-admin/approver-mappings/:userId
   */
  static deleteMapping = asyncHandler(async (req: AuthRequest, res: Response) => {
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
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;

    await ApproverMappingService.deleteMapping(userId, companyId);

    res.status(200).json({
      success: true,
      message: 'Approver mapping deleted successfully',
    });
  });
}


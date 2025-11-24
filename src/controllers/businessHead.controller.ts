import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { BusinessHeadService } from '../services/businessHead.service';
import { reportFiltersSchema } from '../utils/dtoTypes';

export class BusinessHeadController {
  /**
   * Get dashboard statistics
   * GET /api/v1/business-head/dashboard
   */
  static getDashboard = asyncHandler(async (req: AuthRequest, res: Response) => {
    const businessHeadId = req.user!.id;
    const stats = await BusinessHeadService.getDashboardStats(businessHeadId);

    res.status(200).json({
      success: true,
      data: stats,
    });
  });

  /**
   * Get all managers
   * GET /api/v1/business-head/managers
   */
  static getManagers = asyncHandler(async (req: AuthRequest, res: Response) => {
    const businessHeadId = req.user!.id;
    const managers = await BusinessHeadService.getManagers(businessHeadId);

    res.status(200).json({
      success: true,
      data: managers,
    });
  });

  /**
   * Get manager details
   * GET /api/v1/business-head/managers/:id
   */
  static getManagerDetails = asyncHandler(async (req: AuthRequest, res: Response) => {
    const businessHeadId = req.user!.id;
    const managers = await BusinessHeadService.getManagers(businessHeadId);
    const manager = managers.find(m => m.id === req.params.id);

    if (!manager) {
      res.status(404).json({
        success: false,
        message: 'Manager not found',
        code: 'MANAGER_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: manager,
    });
  });

  /**
   * Get all company reports
   * GET /api/v1/business-head/reports
   */
  static getCompanyReports = asyncHandler(async (req: AuthRequest, res: Response) => {
    const businessHeadId = req.user!.id;
    const filters = reportFiltersSchema.parse(req.query);
    const result = await BusinessHeadService.getCompanyReports(businessHeadId, filters);

    res.status(200).json({
      success: true,
      data: result.reports,
      pagination: {
        total: result.total,
        page: filters.page || 1,
        pageSize: filters.pageSize || 20,
      },
    });
  });

  /**
   * Get pending reports
   * GET /api/v1/business-head/reports/pending
   */
  static getPendingReports = asyncHandler(async (req: AuthRequest, res: Response) => {
    const businessHeadId = req.user!.id;
    const reports = await BusinessHeadService.getPendingReports(businessHeadId);

    res.status(200).json({
      success: true,
      data: reports,
    });
  });

  /**
   * Get report details
   * GET /api/v1/business-head/reports/:id
   */
  static getReportDetails = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { ReportsService } = await import('../services/reports.service');
    const report = await ReportsService.getReportById(
      req.params.id,
      req.user!.id,
      req.user!.role
    );

    if (!report) {
      res.status(404).json({
        success: false,
        message: 'Report not found',
        code: 'REPORT_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: report,
    });
  });

  /**
   * Approve report
   * POST /api/v1/business-head/reports/:id/approve
   */
  static approveReport = asyncHandler(async (req: AuthRequest, res: Response) => {
    const businessHeadId = req.user!.id;
    const { comment } = req.body;
    const report = await BusinessHeadService.approveReport(
      req.params.id,
      businessHeadId,
      comment
    );

    res.status(200).json({
      success: true,
      data: report,
      message: 'Report approved successfully',
    });
  });

  /**
   * Reject report
   * POST /api/v1/business-head/reports/:id/reject
   */
  static rejectReport = asyncHandler(async (req: AuthRequest, res: Response) => {
    const businessHeadId = req.user!.id;
    const { comment } = req.body;
    const report = await BusinessHeadService.rejectReport(
      req.params.id,
      businessHeadId,
      comment
    );

    res.status(200).json({
      success: true,
      data: report,
      message: 'Report rejected successfully',
    });
  });

  /**
   * Request report changes
   * POST /api/v1/business-head/reports/:id/request-changes
   */
  static requestReportChanges = asyncHandler(async (req: AuthRequest, res: Response) => {
    // For now, this can be similar to reject but with a different status
    // You might want to implement a specific status for "changes requested"
    const businessHeadId = req.user!.id;
    const { comment } = req.body;
    
    if (!comment || !comment.trim()) {
      res.status(400).json({
        success: false,
        message: 'Comment is required when requesting changes',
        code: 'COMMENT_REQUIRED',
      });
      return;
    }

    // For now, we'll reject with a comment indicating changes are needed
    const report = await BusinessHeadService.rejectReport(
      req.params.id,
      businessHeadId,
      comment
    );

    res.status(200).json({
      success: true,
      data: report,
      message: 'Changes requested successfully',
    });
  });

  /**
   * Get settings
   * GET /api/v1/business-head/settings
   */
  static getSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get company settings that business head can view/modify
    const { CompanySettings } = await import('../models/CompanySettings');
    const businessHead = await import('../models/User').then(m => m.User.findById(req.user!.id).select('companyId').exec());
    
    if (!businessHead || !businessHead.companyId) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    let settings = await CompanySettings.findOne({ companyId: businessHead.companyId }).exec();
    
    if (!settings) {
      // Create default settings
      settings = new CompanySettings({
        companyId: businessHead.companyId,
      });
      await settings.save();
    }

    res.status(200).json({
      success: true,
      data: settings,
    });
  });

  /**
   * Update settings
   * PUT /api/v1/business-head/settings
   */
  static updateSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { CompanySettings } = await import('../models/CompanySettings');
    const businessHead = await import('../models/User').then(m => m.User.findById(req.user!.id).select('companyId').exec());
    
    if (!businessHead || !businessHead.companyId) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    let settings = await CompanySettings.findOne({ companyId: businessHead.companyId }).exec();
    
    if (!settings) {
      settings = new CompanySettings({
        companyId: businessHead.companyId,
      });
    }

    // Update allowed settings (business head can modify certain settings)
    if (req.body.requireBusinessHeadApproval !== undefined) {
      settings.approvalFlow.requireBusinessHeadApproval = req.body.requireBusinessHeadApproval;
    }
    if (req.body.autoApproveThreshold !== undefined) {
      settings.approvalFlow.autoApproveThreshold = req.body.autoApproveThreshold;
    }
    if (req.body.notificationSettings !== undefined) {
      settings.notifications = {
        ...settings.notifications,
        ...req.body.notificationSettings,
      };
    }

    await settings.save();

    res.status(200).json({
      success: true,
      data: settings,
      message: 'Settings updated successfully',
    });
  });
}


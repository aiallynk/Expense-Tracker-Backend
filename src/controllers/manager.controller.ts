import { Response } from 'express';
import { z } from 'zod';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ManagerService } from '../services/manager.service';

const managerReportFiltersSchema = z.object({
  status: z.string().optional(),
  search: z.string().optional(),
  page: z.string().optional().transform(val => parseInt(val || '1', 10)),
  pageSize: z.string().optional().transform(val => parseInt(val || '20', 10)),
});

const approveRejectSchema = z.object({
  comment: z.string().optional(),
});

export class ManagerController {
  /**
   * Get team members (employees under this manager)
   */
  static getTeamMembers = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const teamMembers = await ManagerService.getTeamMembers(req.user!.id);

    res.status(200).json({
      success: true,
      data: teamMembers,
    });
  });

  /**
   * Get team reports
   */
  static getTeamReports = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const filters = managerReportFiltersSchema.parse(req.query);
    const result = await ManagerService.getTeamReports(req.user!.id, filters);

    res.status(200).json({
      success: true,
      data: result.reports,
      pagination: {
        total: result.total,
        page: filters.page,
        pageSize: filters.pageSize,
      },
    });
  });

  /**
   * Get team expenses
   */
  static getTeamExpenses = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const filters = managerReportFiltersSchema.parse(req.query);
    const result = await ManagerService.getTeamExpenses(req.user!.id, filters);

    res.status(200).json({
      success: true,
      data: result.expenses,
      pagination: {
        total: result.total,
        page: filters.page,
        pageSize: filters.pageSize,
      },
    });
  });

  /**
   * Get manager dashboard stats
   */
  static getDashboard = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const stats = await ManagerService.getManagerDashboardStats(req.user!.id);

    res.status(200).json({
      success: true,
      data: stats,
    });
  });

  /**
   * Get team spending details with member-wise breakdown
   */
  static getTeamSpendingDetails = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const details = await ManagerService.getTeamSpendingDetails(
      req.user!.id,
      req.params.teamId
    );

    res.status(200).json({
      success: true,
      data: details,
    });
  });

  /**
   * Get report for review
   */
  static getReportForReview = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const report = await ManagerService.getReportForReview(req.params.id, req.user!.id);

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
   */
  static approveReport = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const { comment } = approveRejectSchema.parse(req.body);
    const report = await ManagerService.approveReport(
      req.params.id,
      req.user!.id,
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
   */
  static rejectReport = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const { comment } = approveRejectSchema.parse(req.body);
    const report = await ManagerService.rejectReport(
      req.params.id,
      req.user!.id,
      comment
    );

    res.status(200).json({
      success: true,
      data: report,
      message: 'Report rejected successfully',
    });
  });

  /**
   * Approve individual expense
   */
  static approveExpense = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const { comment } = approveRejectSchema.parse(req.body);
    const expense = await ManagerService.approveExpense(
      req.params.id,
      req.user!.id,
      comment
    );

    res.status(200).json({
      success: true,
      data: expense,
      message: 'Expense approved successfully',
    });
  });

  /**
   * Reject individual expense
   */
  static rejectExpense = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const { comment } = approveRejectSchema.parse(req.body);
    if (!comment || !comment.trim()) {
      res.status(400).json({
        success: false,
        message: 'Comment is required when rejecting an expense',
        code: 'COMMENT_REQUIRED',
      });
      return;
    }

    const expense = await ManagerService.rejectExpense(
      req.params.id,
      req.user!.id,
      comment
    );

    res.status(200).json({
      success: true,
      data: expense,
      message: 'Expense rejected successfully',
    });
  });

  /**
   * Request changes for individual expense
   */
  static requestExpenseChanges = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'MANAGER') {
      res.status(403).json({
        success: false,
        message: 'Only managers can access this endpoint',
      });
      return;
    }

    const { comment } = approveRejectSchema.parse(req.body);
    if (!comment || !comment.trim()) {
      res.status(400).json({
        success: false,
        message: 'Comment is required when requesting expense changes',
        code: 'COMMENT_REQUIRED',
      });
      return;
    }

    const expense = await ManagerService.requestExpenseChanges(
      req.params.id,
      req.user!.id,
      comment
    );

    res.status(200).json({
      success: true,
      data: expense,
      message: 'Changes requested successfully',
    });
  });
}

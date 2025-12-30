import { Response } from 'express';

import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { AccountantService } from '../services/accountant.service';
import { ExportService } from '../services/export.service';
import { reportFiltersSchema, bulkCsvExportFiltersSchema } from '../utils/dtoTypes';

export class AccountantController {
  /**
   * Get dashboard statistics
   * GET /api/v1/accountant/dashboard
   */
  static getDashboard = asyncHandler(async (req: AuthRequest, res: Response) => {
    const accountantId = req.user!.id;
    const stats = await AccountantService.getDashboardStats(accountantId);

    res.status(200).json({
      success: true,
      data: stats,
    });
  });

  /**
   * Get all reports (read-only)
   * GET /api/v1/accountant/reports
   */
  static getReports = asyncHandler(async (req: AuthRequest, res: Response) => {
    const accountantId = req.user!.id;
    const filters = {
      ...reportFiltersSchema.parse(req.query),
      departmentId: req.query.departmentId as string | undefined,
      projectId: req.query.projectId as string | undefined,
      costCentreId: req.query.costCentreId as string | undefined,
    };
    
    const result = await AccountantService.getReports(accountantId, filters);

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
   * Get report details (read-only)
   * GET /api/v1/accountant/reports/:id
   */
  static getReportDetails = asyncHandler(async (req: AuthRequest, res: Response) => {
    const accountantId = req.user!.id;
    const reportId = req.params.id;
    
    const result = await AccountantService.getReportDetails(accountantId, reportId);

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  /**
   * Get department-wise expenses
   * GET /api/v1/accountant/expenses/department-wise
   */
  static getDepartmentWiseExpenses = asyncHandler(async (req: AuthRequest, res: Response) => {
    const accountantId = req.user!.id;
    const accountant = await import('../models/User').then(m => m.User.findById(accountantId).select('companyId').exec());
    
    if (!accountant || !accountant.companyId) {
      res.status(404).json({
        success: false,
        message: 'Accountant not found or not associated with a company',
      });
      return;
    }

    const departmentSpend = await AccountantService.getDepartmentWiseSpend(accountant.companyId);

    res.status(200).json({
      success: true,
      data: departmentSpend,
    });
  });

  /**
   * Get project-wise expenses
   * GET /api/v1/accountant/expenses/project-wise
   */
  static getProjectWiseExpenses = asyncHandler(async (req: AuthRequest, res: Response) => {
    const accountantId = req.user!.id;
    const accountant = await import('../models/User').then(m => m.User.findById(accountantId).select('companyId').exec());
    
    if (!accountant || !accountant.companyId) {
      res.status(404).json({
        success: false,
        message: 'Accountant not found or not associated with a company',
      });
      return;
    }

    const projectSpend = await AccountantService.getProjectWiseSpend(accountant.companyId);

    res.status(200).json({
      success: true,
      data: projectSpend,
    });
  });

  /**
   * Get cost centre-wise expenses
   * GET /api/v1/accountant/expenses/cost-centre-wise
   */
  static getCostCentreWiseExpenses = asyncHandler(async (req: AuthRequest, res: Response) => {
    const accountantId = req.user!.id;
    const accountant = await import('../models/User').then(m => m.User.findById(accountantId).select('companyId').exec());
    
    if (!accountant || !accountant.companyId) {
      res.status(404).json({
        success: false,
        message: 'Accountant not found or not associated with a company',
      });
      return;
    }

    const costCentreSpend = await AccountantService.getCostCentreWiseSpend(accountant.companyId);

    res.status(200).json({
      success: true,
      data: costCentreSpend,
    });
  });

  /**
   * Bulk CSV Export with filtering
   * GET /api/v1/accountant/export/csv
   * Accountant role only
   */
  static bulkCsvExport = asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = bulkCsvExportFiltersSchema.parse(req.query);
    
    // Get company ID from accountant's user record
    const { User } = await import('../models/User');
    const accountant = await User.findById(req.user!.id).select('companyId').exec();
    
    if (!accountant || !accountant.companyId) {
      res.status(404).json({
        success: false,
        message: 'Accountant not found or not associated with a company',
      });
      return;
    }

    const companyId = accountant.companyId.toString();

    const csvBuffer = await ExportService.generateBulkCSV({
      ...filters,
      companyId,
      fromDate: filters.fromDate ? new Date(filters.fromDate) : undefined,
      toDate: filters.toDate ? new Date(filters.toDate) : undefined,
    });

    // Generate filename
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `expense-export-${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csvBuffer);
  });
}


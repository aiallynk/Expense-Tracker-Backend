import { Response } from 'express';

import { AnalyticsRequest } from '../middleware/analyticsAuth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { AnalyticsService } from '../services/analytics.service';

export class AnalyticsController {
  /**
   * Get dashboard summary statistics
   * GET /api/v1/analytics/dashboard
   * Query params: companyId (required), fromDate?, toDate?
   */
  static getDashboard = asyncHandler(async (req: AnalyticsRequest, res: Response) => {
    const companyId = req.query.companyId as string;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'companyId query parameter is required',
        code: 'MISSING_COMPANY_ID',
      });
      return;
    }

    // Validate companyId exists
    const isValid = await AnalyticsService.validateCompanyId(companyId);
    if (!isValid) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    // Parse date filters
    const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
    const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;

    // Validate dates
    if (fromDate && isNaN(fromDate.getTime())) {
      res.status(400).json({
        success: false,
        message: 'Invalid fromDate format. Use ISO 8601 format (e.g., 2024-01-01T00:00:00Z)',
        code: 'INVALID_DATE',
      });
      return;
    }

    if (toDate && isNaN(toDate.getTime())) {
      res.status(400).json({
        success: false,
        message: 'Invalid toDate format. Use ISO 8601 format (e.g., 2024-12-31T23:59:59Z)',
        code: 'INVALID_DATE',
      });
      return;
    }

    const stats = await AnalyticsService.getDashboardSummary(companyId, fromDate, toDate);

    res.status(200).json({
      success: true,
      data: stats,
    });
  });

  /**
   * Get department-wise expenses
   * GET /api/v1/analytics/expenses/department-wise
   * Query params: companyId (required), fromDate?, toDate?
   */
  static getDepartmentWiseExpenses = asyncHandler(async (req: AnalyticsRequest, res: Response) => {
    const companyId = req.query.companyId as string;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'companyId query parameter is required',
        code: 'MISSING_COMPANY_ID',
      });
      return;
    }

    const isValid = await AnalyticsService.validateCompanyId(companyId);
    if (!isValid) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
    const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;

    const data = await AnalyticsService.getDepartmentWiseExpenses(companyId, fromDate, toDate);

    res.status(200).json({
      success: true,
      data,
    });
  });

  /**
   * Get project-wise expenses
   * GET /api/v1/analytics/expenses/project-wise
   * Query params: companyId (required), fromDate?, toDate?
   */
  static getProjectWiseExpenses = asyncHandler(async (req: AnalyticsRequest, res: Response) => {
    const companyId = req.query.companyId as string;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'companyId query parameter is required',
        code: 'MISSING_COMPANY_ID',
      });
      return;
    }

    const isValid = await AnalyticsService.validateCompanyId(companyId);
    if (!isValid) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
    const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;

    const data = await AnalyticsService.getProjectWiseExpenses(companyId, fromDate, toDate);

    res.status(200).json({
      success: true,
      data,
    });
  });

  /**
   * Get cost centre-wise expenses
   * GET /api/v1/analytics/expenses/cost-centre-wise
   * Query params: companyId (required), fromDate?, toDate?
   */
  static getCostCentreWiseExpenses = asyncHandler(async (req: AnalyticsRequest, res: Response) => {
    const companyId = req.query.companyId as string;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'companyId query parameter is required',
        code: 'MISSING_COMPANY_ID',
      });
      return;
    }

    const isValid = await AnalyticsService.validateCompanyId(companyId);
    if (!isValid) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
    const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;

    const data = await AnalyticsService.getCostCentreWiseExpenses(companyId, fromDate, toDate);

    res.status(200).json({
      success: true,
      data,
    });
  });

  /**
   * Get category-wise expenses
   * GET /api/v1/analytics/expenses/category-wise
   * Query params: companyId (required), fromDate?, toDate?
   */
  static getCategoryWiseExpenses = asyncHandler(async (req: AnalyticsRequest, res: Response) => {
    const companyId = req.query.companyId as string;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'companyId query parameter is required',
        code: 'MISSING_COMPANY_ID',
      });
      return;
    }

    const isValid = await AnalyticsService.validateCompanyId(companyId);
    if (!isValid) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
    const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;

    const data = await AnalyticsService.getCategoryWiseExpenses(companyId, fromDate, toDate);

    res.status(200).json({
      success: true,
      data,
    });
  });

  /**
   * Get monthly expense trends
   * GET /api/v1/analytics/trends/monthly
   * Query params: companyId (required), months? (default: 12)
   */
  static getMonthlyTrends = asyncHandler(async (req: AnalyticsRequest, res: Response) => {
    const companyId = req.query.companyId as string;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'companyId query parameter is required',
        code: 'MISSING_COMPANY_ID',
      });
      return;
    }

    const isValid = await AnalyticsService.validateCompanyId(companyId);
    if (!isValid) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const months = req.query.months ? parseInt(req.query.months as string, 10) : 12;
    if (isNaN(months) || months < 1 || months > 24) {
      res.status(400).json({
        success: false,
        message: 'months must be a number between 1 and 24',
        code: 'INVALID_MONTHS',
      });
      return;
    }

    const data = await AnalyticsService.getMonthlyTrends(companyId, months);

    res.status(200).json({
      success: true,
      data,
    });
  });

  /**
   * Get expense reports list (read-only)
   * GET /api/v1/analytics/reports
   * Query params: companyId (required), page?, pageSize?, fromDate?, toDate?, status?
   */
  static getReports = asyncHandler(async (req: AnalyticsRequest, res: Response) => {
    const companyId = req.query.companyId as string;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'companyId query parameter is required',
        code: 'MISSING_COMPANY_ID',
      });
      return;
    }

    const isValid = await AnalyticsService.validateCompanyId(companyId);
    if (!isValid) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 20;
    const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
    const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;
    const status = req.query.status as string | undefined;

    if (isNaN(page) || page < 1) {
      res.status(400).json({
        success: false,
        message: 'page must be a positive integer',
        code: 'INVALID_PAGE',
      });
      return;
    }

    if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
      res.status(400).json({
        success: false,
        message: 'pageSize must be between 1 and 100',
        code: 'INVALID_PAGE_SIZE',
      });
      return;
    }

    const result = await AnalyticsService.getExpenseReports(companyId, {
      page,
      pageSize,
      fromDate,
      toDate,
      status,
    });

    res.status(200).json({
      success: true,
      data: result.reports,
      pagination: result.pagination,
    });
  });

  /**
   * Get expenses list (read-only)
   * GET /api/v1/analytics/expenses
   * Query params: companyId (required), page?, pageSize?, fromDate?, toDate?, status?
   */
  static getExpenses = asyncHandler(async (req: AnalyticsRequest, res: Response) => {
    const companyId = req.query.companyId as string;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'companyId query parameter is required',
        code: 'MISSING_COMPANY_ID',
      });
      return;
    }

    const isValid = await AnalyticsService.validateCompanyId(companyId);
    if (!isValid) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 20;
    const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
    const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;
    const status = req.query.status as string | undefined;

    if (isNaN(page) || page < 1) {
      res.status(400).json({
        success: false,
        message: 'page must be a positive integer',
        code: 'INVALID_PAGE',
      });
      return;
    }

    if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
      res.status(400).json({
        success: false,
        message: 'pageSize must be between 1 and 100',
        code: 'INVALID_PAGE_SIZE',
      });
      return;
    }

    const result = await AnalyticsService.getExpenses(companyId, {
      page,
      pageSize,
      fromDate,
      toDate,
      status,
    });

    res.status(200).json({
      success: true,
      data: result.expenses,
      pagination: result.pagination,
    });
  });
}


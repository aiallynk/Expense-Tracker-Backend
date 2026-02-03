import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ExpensesService } from '../services/expenses.service';
import { ExportService } from '../services/export.service';
import { ReportsService } from '../services/reports.service';
import { getDashboardPayload, enqueueAnalyticsEvent, rebuildSnapshotsForCompany } from '../services/companyAnalyticsSnapshot.service';
import {
  reportFiltersSchema,
  expenseFiltersSchema,
  exportQuerySchema,
  bulkCsvExportFiltersSchema,
} from '../utils/dtoTypes';
import { ExpenseReportStatus, ExpenseStatus, ExportFormat } from '../utils/enums';

import { logger } from '@/config/logger';
import { cacheService, cacheKeys } from '../services/cache.service';

// WebSocket event emission for SuperAdmin insights
const emitSuperAdminEvent = (event: string, data: any) => {
  try {
    // Import the WebSocket emitter (would be implemented in socket service)
    const io = (global as any).io;
    if (io) {
      io.to('super-admin').emit(`super-admin:${event}`, data);
      logger.info({ event, data }, 'SuperAdmin insight event emitted');
    }
  } catch (error) {
    logger.error({ error, event, data }, 'Failed to emit SuperAdmin insight event');
  }
};

export class AdminController {
  // Reports
  static getAllReports = asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = reportFiltersSchema.parse(req.query);
    const result = await ReportsService.adminGetReports(filters, req);

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  static approveReport = asyncHandler(async (req: AuthRequest, res: Response) => {
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const report = await ReportsService.adminChangeStatus(
      reportId,
      ExpenseReportStatus.APPROVED,
      req.user!.id
    );

    res.status(200).json({
      success: true,
      data: report,
      message: 'Report approved successfully',
    });
  });

  static rejectReport = asyncHandler(async (req: AuthRequest, res: Response) => {
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const report = await ReportsService.adminChangeStatus(
      reportId,
      ExpenseReportStatus.REJECTED,
      req.user!.id
    );

    res.status(200).json({
      success: true,
      data: report,
      message: 'Report rejected successfully',
    });
  });

  static exportReport = asyncHandler(async (req: AuthRequest, res: Response) => {
    const query = exportQuerySchema.parse(req.query);
    const format = (query.format || ExportFormat.XLSX) as ExportFormat;
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const result = await ExportService.generateExport(reportId, format);

    res.status(200).json({
      success: true,
      data: {
        downloadUrl: result.downloadUrl,
        format,
      },
    });
  });

  /**
   * Bulk CSV Export with filtering
   * GET /api/v1/admin/export/csv
   * Only Admin & Accountant roles
   */
  static bulkCsvExport = asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = bulkCsvExportFiltersSchema.parse(req.query);
    
    // Get company ID from user if not provided
    let companyId = filters.companyId;
    if (!companyId && req.user!.role === 'COMPANY_ADMIN') {
      const { CompanyAdmin } = await import('../models/CompanyAdmin');
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).select('companyId').exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (!companyId && req.user!.role !== 'ADMIN' && req.user!.role !== 'SUPER_ADMIN') {
      // For Accountant, get from user's companyId
      const { User } = await import('../models/User');
      const user = await User.findById(req.user!.id).select('companyId').exec();
      if (user && user.companyId) {
        companyId = user.companyId.toString();
      }
    }

    const excelBuffer = await ExportService.generateBulkExcel({
      ...filters,
      companyId,
      fromDate: filters.fromDate ? new Date(filters.fromDate) : undefined,
      toDate: filters.toDate ? new Date(filters.toDate) : undefined,
    });

    // Generate filename
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `expense-export-${timestamp}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(excelBuffer);
  });

  /**
   * Bulk Excel Export with filtering (Structured Reimbursement Forms)
   * GET /api/v1/admin/export/excel
   * Only Admin & Accountant roles
   */
  static bulkExcelExport = asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = bulkCsvExportFiltersSchema.parse(req.query);
    
    // Get company ID from user if not provided
    let companyId = filters.companyId;
    if (!companyId && req.user!.role === 'COMPANY_ADMIN') {
      const { CompanyAdmin } = await import('../models/CompanyAdmin');
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).select('companyId').exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (!companyId && req.user!.role !== 'ADMIN' && req.user!.role !== 'SUPER_ADMIN') {
      // For Accountant, get from user's companyId
      const { User } = await import('../models/User');
      const user = await User.findById(req.user!.id).select('companyId').exec();
      if (user && user.companyId) {
        companyId = user.companyId.toString();
      }
    }

    const excelBuffer = await ExportService.generateBulkExcel({
      ...filters,
      companyId,
      fromDate: filters.fromDate ? new Date(filters.fromDate) : undefined,
      toDate: filters.toDate ? new Date(filters.toDate) : undefined,
    });

    // Generate filename
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `expense-reimbursement-forms-${timestamp}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(excelBuffer);
  });

  // Expenses
  static getAllExpenses = asyncHandler(async (req: AuthRequest, res: Response) => {
    // #region agent log
    const fs = require('fs');
    const logPath = 'd:\\APPs\\Expence Track\\.cursor\\debug.log';
    const logEntry = JSON.stringify({location:'admin.controller.ts:175',message:'getAllExpenses entry',data:{query:req.query,userId:req.user?.id,role:req.user?.role},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n';
    fs.appendFileSync(logPath, logEntry);
    // #endregion
    
    let filters;
    try {
      // #region agent log
      const logEntry2 = JSON.stringify({location:'admin.controller.ts:178',message:'Before schema parse',data:{queryKeys:Object.keys(req.query)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n';
      fs.appendFileSync(logPath, logEntry2);
      // #endregion
      filters = expenseFiltersSchema.parse(req.query);
      // #region agent log
      const logEntry3 = JSON.stringify({location:'admin.controller.ts:180',message:'After schema parse',data:{filters},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n';
      fs.appendFileSync(logPath, logEntry3);
      // #endregion
    } catch (parseError: any) {
      // #region agent log
      const logEntry4 = JSON.stringify({location:'admin.controller.ts:183',message:'Schema parse error',data:{error:parseError.message,query:req.query},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n';
      fs.appendFileSync(logPath, logEntry4);
      // #endregion
      throw parseError;
    }
    
    let result;
    try {
      // #region agent log
      const logEntry5 = JSON.stringify({location:'admin.controller.ts:191',message:'Before adminListExpenses',data:{filters},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})+'\n';
      fs.appendFileSync(logPath, logEntry5);
      // #endregion
      result = await ExpensesService.adminListExpenses(filters, req);
      // #region agent log
      const logEntry6 = JSON.stringify({location:'admin.controller.ts:194',message:'After adminListExpenses',data:{resultCount:result?.expenses?.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})+'\n';
      fs.appendFileSync(logPath, logEntry6);
      // #endregion
    } catch (serviceError: any) {
      // #region agent log
      const logEntry7 = JSON.stringify({location:'admin.controller.ts:197',message:'adminListExpenses error',data:{error:serviceError.message,stack:serviceError.stack},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})+'\n';
      fs.appendFileSync(logPath, logEntry7);
      // #endregion
      throw serviceError;
    }

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  static approveExpense = asyncHandler(async (req: AuthRequest, res: Response) => {
    const expenseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const expense = await ExpensesService.adminChangeExpenseStatus(
      expenseId,
      ExpenseStatus.APPROVED,
      req.user!.id
    );

    res.status(200).json({
      success: true,
      data: expense,
      message: 'Expense approved successfully',
    });
  });

  static rejectExpense = asyncHandler(async (req: AuthRequest, res: Response) => {
    const expenseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const expense = await ExpensesService.adminChangeExpenseStatus(
      expenseId,
      ExpenseStatus.REJECTED,
      req.user!.id
    );

    res.status(200).json({
      success: true,
      data: expense,
      message: 'Expense rejected successfully',
    });
  });

  // Dashboard – read from company_analytics_snapshot only (no aggregation)
  static getDashboard = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { CompanyAdmin } = await import('../models/CompanyAdmin');
    const { ExpenseReport } = await import('../models/ExpenseReport');
    const { User } = await import('../models/User');
    let companyId: string | undefined;

    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    }

    if (!companyId) {
      return res.status(200).json({
        success: true,
        data: {
          totalReports: 0,
          totalExpenses: 0,
          pendingReports: 0,
          approvedReports: 0,
          totalAmount: 0,
          totalAmountThisMonth: 0,
          totalUsers: 0,
          employees: 0,
          managers: 0,
          businessHeads: 0,
        },
      }) as any;
    }

    const dashboardData = await getDashboardPayload(companyId);
    const snapshot = await import('../services/companyAnalyticsSnapshot.service').then(
      (m) => m.getSnapshotForDashboard(companyId)
    );
    if (!snapshot || (snapshot.totalExpenseAmount === 0 && snapshot.approvedReports === 0)) {
      try {
        enqueueAnalyticsEvent({ companyId, event: 'REBUILD_SNAPSHOT' });
      } catch (_) {
        // ignore
      }
    }
    const companyUsers = await User.find({ companyId }).select('_id').exec();
    const userIds = companyUsers.map((u) => u._id);
    const [pendingReports, totalExpenses] = await Promise.all([
      userIds.length > 0
        ? ExpenseReport.countDocuments({
            userId: { $in: userIds },
            status: {
              $nin: [
                ExpenseReportStatus.DRAFT,
                ExpenseReportStatus.APPROVED,
                ExpenseReportStatus.REJECTED,
                ExpenseReportStatus.CHANGES_REQUESTED,
              ],
            },
          })
        : 0,
      userIds.length > 0
        ? (await import('../models/Expense')).Expense.countDocuments({ userId: { $in: userIds } })
        : 0,
    ]);

    res.status(200).json({
      success: true,
      data: {
        ...dashboardData,
        pendingReports,
        pendingApprovals: pendingReports,
        totalExpenses,
      },
    });
  });

  // Company Analytics – reports/financial from snapshot; OCR/storage/API from existing sources
  static getCompanyAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { ExpenseReport } = await import('../models/ExpenseReport');
    const { Expense: ExpenseModel } = await import('../models/Expense');
    const { Receipt } = await import('../models/Receipt');
    const { User } = await import('../models/User');
    const { CompanyAdmin } = await import('../models/CompanyAdmin');
    const { getSnapshotForDashboard } = await import('../services/companyAnalyticsSnapshot.service');

    const companyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const cacheKey = cacheKeys.companyAnalytics(companyId, req.query);

    // Get company admin to verify access
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
      if (!companyAdmin || companyAdmin.companyId.toString() !== companyId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        }) as any;
      }
    }

    // Get all user IDs in this company
    const companyUsers = await User.find({ companyId })
      .select('_id')
      .exec();
    const userIds = companyUsers.map(u => u._id);

    // Snapshot for reports/financial (single source of truth)
    const snapshot = await getSnapshotForDashboard(companyId);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    // OCR Analytics
    const ocrStats = await ExpenseModel.aggregate([
      { $match: { userId: { $in: userIds } } },
      {
        $lookup: {
          from: 'receipts',
          localField: '_id',
          foreignField: 'expenseId',
          as: 'receipts'
        }
      },
      { $unwind: { path: '$receipts', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: null,
          totalOCR: { $sum: 1 },
          successfulOCR: {
            $sum: {
              $cond: [{ $eq: ['$receipts.ocrStatus', 'completed'] }, 1, 0]
            }
          },
          avgProcessingTime: { $avg: '$receipts.processingTimeMs' },
          monthlyOCR: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gte: ['$createdAt', startOfMonth] },
                    { $lte: ['$createdAt', endOfMonth] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    // Reports analytics from snapshot (no aggregation)
    const totalReports = snapshot?.totalReports ?? 0;
    const approvedReports = snapshot?.approvedReports ?? 0;
    const rejectedReports = snapshot?.rejectedReports ?? 0;
    const pendingReportsAgg =
      userIds.length > 0
        ? await ExpenseReport.countDocuments({
            userId: { $in: userIds },
            status: {
              $in: [
                ExpenseReportStatus.SUBMITTED,
                ExpenseReportStatus.PENDING_APPROVAL_L1,
                ExpenseReportStatus.PENDING_APPROVAL_L2,
                ExpenseReportStatus.PENDING_APPROVAL_L3,
                ExpenseReportStatus.PENDING_APPROVAL_L4,
                ExpenseReportStatus.PENDING_APPROVAL_L5,
              ],
            },
          })
        : 0;

    // API Usage Analytics
    const apiStats = await ExpenseModel.aggregate([
      { $match: { userId: { $in: userIds } } },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: 1 },
          monthlyExpenses: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gte: ['$createdAt', startOfMonth] },
                    { $lte: ['$createdAt', endOfMonth] }
                  ]
                },
                1,
                0
              ]
            }
          },
          totalAmount: { $sum: '$amount' }
        }
      }
    ]);

    // Storage Analytics
    const storageStats = await Receipt.aggregate([
      {
        $lookup: {
          from: 'expenses',
          localField: 'expenseId',
          foreignField: '_id',
          as: 'expense'
        }
      },
      { $unwind: '$expense' },
      { $match: { 'expense.userId': { $in: userIds } } },
      {
        $group: {
          _id: null,
          totalSizeGB: { $sum: { $divide: ['$sizeBytes', 1073741824] } }, // Convert to GB
          ocrFiles: {
            $sum: {
              $cond: [{ $ne: ['$ocrText', null] }, 1, 0]
            }
          },
          totalFiles: { $sum: 1 }
        }
      }
    ]);

    const totalApprovedAmount = snapshot?.totalExpenseAmount ?? snapshot?.approvedExpenseAmount ?? 0;

    // Compile analytics response (reports + financial from snapshot)
    const analytics = {
      ocrUsage: {
        totalLifetime: ocrStats[0]?.totalOCR || 0,
        thisMonth: ocrStats[0]?.monthlyOCR || 0,
        perUser: userIds.length > 0 ? Math.round((ocrStats[0]?.totalOCR || 0) / userIds.length) : 0,
        successRate: ocrStats[0]?.totalOCR > 0 ? Math.round((ocrStats[0]?.successfulOCR || 0) / ocrStats[0].totalOCR * 100) : 0,
        avgProcessingTime: Math.round((ocrStats[0]?.avgProcessingTime || 0) / 1000) // Convert to seconds
      },
      reports: {
        totalCreated: totalReports,
        perMonth: totalReports, // snapshot is current month
        approvalRate: totalReports > 0 ? Math.round((approvedReports / totalReports) * 100) : 0,
        avgApprovalTime: 0, // not in snapshot; could add if needed
        statusBreakdown: {
          approved: approvedReports,
          pending: pendingReportsAgg,
          rejected: rejectedReports
        }
      },
      apiUsage: {
        totalCalls: apiStats[0]?.totalExpenses || 0,
        callsThisMonth: apiStats[0]?.monthlyExpenses || 0,
        perUser: userIds.length > 0 ? Math.round((apiStats[0]?.totalExpenses || 0) / userIds.length) : 0,
        errorRate: 2.1, // Mock - would need error logging
        topEndpoints: ['/expenses', '/reports', '/ocr']
      },
      storage: {
        usedGB: Math.round((storageStats[0]?.totalSizeGB || 0) * 100) / 100,
        allocatedGB: 50, // Mock - would come from company plan
        growthRateMonthly: 0.8, // Mock - would calculate from historical data
        ocrContribution: storageStats[0]?.totalFiles > 0 ? Math.round((storageStats[0]?.ocrFiles || 0) / storageStats[0].totalFiles * 100) : 0
      },
      financial: {
        mrrContribution: Math.floor((totalApprovedAmount || 0) / 12), // Monthly average
        arrProjection: totalApprovedAmount || 0, // Annual projection
        costPerOCR: 0.019, // Mock - would calculate from actual costs
        efficiencyRatio: userIds.length > 0 ? Math.round((totalApprovedAmount || 0) / userIds.length) : 0,
        voucherUsedAmount: snapshot?.voucherUsedAmount ?? 0,
        employeePaidAmount: snapshot?.employeePaidAmount ?? 0,
        categoryBreakdown: snapshot?.categoryBreakdown ?? {}
      }
    };

    // Cache the result for 10 minutes
    const result = await cacheService.getOrSet(
      cacheKey,
      async () => analytics,
      10 * 60 * 1000 // 10 minutes
    );

    res.status(200).json({
      success: true,
      data: result,
      cached: cacheService.get(cacheKey) === result
    });
  });

  // Rebuild company analytics snapshot (recompute from APPROVED reports/expenses)
  static rebuildCompanyAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { CompanyAdmin } = await import('../models/CompanyAdmin');
    const companyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
      if (!companyAdmin || companyAdmin.companyId.toString() !== companyId) {
        return res.status(403).json({ success: false, message: 'Access denied' }) as any;
      }
    }
    await rebuildSnapshotsForCompany(companyId);
    res.status(200).json({ success: true, message: 'Analytics snapshot rebuilt' });
  });

  // Company Mini Stats (lightweight)
  static getCompanyMiniStats = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { ExpenseReport } = await import('../models/ExpenseReport');
    const { Expense: ExpenseModel } = await import('../models/Expense');
    const { Receipt } = await import('../models/Receipt');
    const { User } = await import('../models/User');

    const companyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const cacheKey = cacheKeys.miniStats(companyId);

    // Get all user IDs in this company
    const companyUsers = await User.find({ companyId })
      .select('_id')
      .exec();
    const userIds = companyUsers.map(u => u._id);

    // Calculate this month range
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    // Get mini stats in parallel
    const [ocrCount, reportsCount, apiCalls, storageGB] = await Promise.all([
      // OCR this month
      ExpenseModel.countDocuments({
        userId: { $in: userIds },
        createdAt: { $gte: startOfMonth, $lte: endOfMonth }
      }),

      // Reports this month
      ExpenseReport.countDocuments({
        userId: { $in: userIds },
        createdAt: { $gte: startOfMonth, $lte: endOfMonth }
      }),

      // API calls (using expense count as proxy)
      ExpenseModel.countDocuments({
        userId: { $in: userIds },
        createdAt: { $gte: startOfMonth, $lte: endOfMonth }
      }),

      // Storage used (simplified)
      Receipt.aggregate([
        {
          $lookup: {
            from: 'expenses',
            localField: 'expenseId',
            foreignField: '_id',
            as: 'expense'
          }
        },
        { $unwind: '$expense' },
        { $match: { 'expense.userId': { $in: userIds } } },
        {
          $group: {
            _id: null,
            totalSizeGB: { $sum: { $divide: ['$sizeBytes', 1073741824] } }
          }
        }
      ]).then(result => Math.round((result[0]?.totalSizeGB || 0) * 100) / 100)
    ]);

    // Cache the result for 1 minute (frequently accessed)
    const result = await cacheService.getOrSet(
      cacheKey,
      async () => ({
        ocrUsage: ocrCount,
        reportsCreated: reportsCount,
        apiCalls: apiCalls,
        storageUsed: storageGB
      }),
      60 * 1000 // 1 minute
    );

    res.status(200).json({
      success: true,
      data: result,
      cached: cacheService.get(cacheKey) === result
    });
  });

  // Get Companies List for Filters
  static getCompaniesList = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const { CompanyAdmin } = await import('../models/CompanyAdmin');

    // Get all companies that have admin users
    const companies = await CompanyAdmin.aggregate([
      {
        $lookup: {
          from: 'users',
          localField: 'companyId',
          foreignField: 'companyId',
          as: 'users'
        }
      },
      {
        $group: {
          _id: '$companyId',
          adminName: { $first: '$name' },
          adminEmail: { $first: '$email' },
          userCount: { $sum: { $size: '$users' } },
          plan: { $first: '$plan' },
          status: { $first: '$status' },
          createdAt: { $first: '$createdAt' }
        }
      },
      {
        $project: {
          id: '$_id',
          name: { $concat: [{$ifNull: ['$adminName', 'Company']}, ' (', {$toString: '$userCount'}, ' users)'] },
          adminName: 1,
          adminEmail: 1,
          userCount: 1,
          plan: 1,
          status: 1,
          createdAt: 1
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: 1000 }
    ]);

    res.status(200).json({
      success: true,
      data: {
        companies: companies.map((company: any) => ({
          id: company.id,
          name: company.name,
          adminName: company.adminName,
          adminEmail: company.adminEmail,
          employeeCount: company.userCount,
          plan: company.plan,
          status: company.status
        }))
      }
    });
  });

  // Enhanced Dashboard with Filters
  static getFilteredDashboard = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { ExpenseReport } = await import('../models/ExpenseReport');
    const { Expense: ExpenseModel } = await import('../models/Expense');
    const { User } = await import('../models/User');
    // const { CompanyAdmin } = await import('../models/CompanyAdmin'); // Not used

    // Parse filters from query
    const filters = req.query;
    const cacheKey = cacheKeys.dashboard(filters);
    const dateRange = (filters.dateRange as string) || '30d';

    // Safely parse array parameters
    const parseStringArray = (param: any): string[] => {
      if (typeof param === 'string') return param.split(',').filter(Boolean);
      if (Array.isArray(param)) return param.filter((item): item is string => typeof item === 'string');
      return [];
    };

    const companyIds = parseStringArray(filters.companyIds);
    const planTypes = parseStringArray(filters.planTypes);
    const companyStatuses = parseStringArray(filters.companyStatuses);

    // Build base queries
    let reportQuery: any = {};
    let expenseQuery: any = {};
    let userQuery: any = {};

    // Apply company filters
    if (companyIds.length > 0) {
      // Get users from selected companies
      const selectedCompanyUsers = await User.find({ companyId: { $in: companyIds } })
        .select('_id')
        .exec();
      const selectedUserIds = selectedCompanyUsers.map(u => u._id);

      reportQuery.userId = { $in: selectedUserIds };
      expenseQuery.userId = { $in: selectedUserIds };
      userQuery.companyId = { $in: companyIds };
    }

    // Apply date range
    let dateFilter = {};
    const now = new Date();
    switch (dateRange) {
      case 'today':
        dateFilter = {
          $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
          $lt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
        };
        break;
      case '7d':
        dateFilter = { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
        break;
      case '90d':
        dateFilter = { $gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) };
        break;
      case 'custom':
        if (filters.startDate && filters.endDate) {
          dateFilter = {
            $gte: new Date(filters.startDate as string),
            $lte: new Date(filters.endDate as string)
          };
        }
        break;
      default: // 30d
        dateFilter = { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
    }

    // Apply date filter to relevant queries
    if (Object.keys(dateFilter).length > 0) {
      reportQuery.createdAt = dateFilter;
      expenseQuery.createdAt = dateFilter;
    }

    // Get filtered stats
    const [
      totalCompanies,
      activeCompanies,
      totalUsers,
      totalReports,
      approvedReports,
      totalAmount,
      ocrUsage,
      storageUsed
    ] = await Promise.all([
      // Total companies (filtered)
      companyIds.length > 0 ? Promise.resolve(companyIds.length) :
        User.distinct('companyId').then(ids => ids.length),

      // Active companies (simplified - would need company status)
      companyIds.length > 0 ? Promise.resolve(companyIds.length) :
        User.distinct('companyId').then(ids => ids.length),

      // Total users (filtered)
      User.countDocuments(userQuery),

      // Total reports
      ExpenseReport.countDocuments(reportQuery),

      // Approved reports
      ExpenseReport.countDocuments({
        ...reportQuery,
        status: { $in: ['APPROVED', 'MANAGER_APPROVED', 'BH_APPROVED'] }
      }),

      // Total approved amount
      ExpenseReport.aggregate([
        { $match: { ...reportQuery, status: 'APPROVED' } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ]).then(result => result[0]?.total || 0),

      // OCR usage (using expense count as proxy)
      ExpenseModel.countDocuments(expenseQuery),

      // Storage used (simplified calculation)
      ExpenseModel.aggregate([
        { $match: expenseQuery },
        {
          $lookup: {
            from: 'receipts',
            localField: '_id',
            foreignField: 'expenseId',
            as: 'receipts'
          }
        },
        { $unwind: { path: '$receipts', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: null,
            totalSize: { $sum: '$receipts.sizeBytes' }
          }
        }
      ]).then(result => Math.round((result[0]?.totalSize || 0) / 1073741824 * 100) / 100) // Convert to GB
    ]);

    const dashboardData = {
      totalCompanies,
      activeCompanies,
      totalUsers,
      totalReports,
      approvedReports,
      totalAmount,
      ocrUsage,
      storageUsed,
      mrr: Math.floor(totalAmount / 12), // Monthly approximation
      arr: totalAmount, // Annual projection
      reportsCreated: totalReports,
      expensesCreated: ocrUsage, // Approximation
      receiptsUploaded: ocrUsage, // Approximation
      mrrTrend: 0, // Would need historical data
      userTrend: 0,
      storageTrend: 0,
      reportTrend: 0,
      totalAmountApproved: totalAmount,
    };

    // Cache the result for 5 minutes
    const result = await cacheService.getOrSet(
      cacheKey,
      async () => ({
        dashboardData,
        appliedFilters: {
          dateRange,
          companyIds,
          planTypes,
          companyStatuses
        }
      }),
      5 * 60 * 1000 // 5 minutes
    );

    res.status(200).json({
      success: true,
      data: result.dashboardData,
      filters: {
        applied: result.appliedFilters
      },
      cached: cacheService.get(cacheKey)?.dashboardData === result.dashboardData
    });
  });

  // Storage Growth Analytics
  static getStorageGrowth = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { Receipt } = await import('../models/Receipt');
    const { Expense } = await import('../models/Expense');
    const { User } = await import('../models/User');
    const { CompanyAdmin } = await import('../models/CompanyAdmin');

    // Get year from query params, default to current year
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    
    // Build query filters based on user role
    let expenseQuery: any = {};

    // If user is COMPANY_ADMIN, filter by their company
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        // Get all user IDs in this company
        const companyUsers = await User.find({ companyId: companyAdmin.companyId })
          .select('_id')
          .exec();
        const userIds = companyUsers.map(u => u._id);

        // Get all expense IDs for this company
        const companyExpenses = await Expense.find({ userId: { $in: userIds } })
          .select('_id')
          .exec();
        const expenseIds = companyExpenses.map(e => e._id);

        expenseQuery = { expenseId: { $in: expenseIds } };
      }
    }

    // Calculate date range for the selected year (all 12 months)
    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year, 11, 31, 23, 59, 59);

    // Aggregate receipts by month for the selected year
    const storageGrowth = await Receipt.aggregate([
      {
        $match: {
          ...expenseQuery,
          createdAt: { $gte: startOfYear, $lte: endOfYear },
          uploadConfirmed: true, // Only count confirmed uploads
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          totalSizeBytes: { $sum: '$sizeBytes' },
          receiptCount: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    // Also get total storage used (all time)
    const totalStorageResult = await Receipt.aggregate([
      {
        $match: {
          ...expenseQuery,
          uploadConfirmed: true,
        },
      },
      {
        $group: {
          _id: null,
          totalSizeBytes: { $sum: '$sizeBytes' },
        },
      },
    ]);

    const totalSizeBytes = totalStorageResult[0]?.totalSizeBytes ?? 0;
    const totalStorageGB = totalSizeBytes ? totalSizeBytes / (1024 * 1024 * 1024) : 0;

    // Calculate cumulative storage - get total storage up to each month
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formattedStorageGrowth: Array<{ name: string; value: number; month: number; year: number }> = [];
    
    // Create a map of monthly data for the selected year
    const dataMap = new Map();
    storageGrowth.forEach((item) => {
      const key = `${item._id.year}-${item._id.month}`;
      dataMap.set(key, item);
    });

    // Calculate storage before the selected year (for cumulative calculation)
    const storageBeforeYearResult = await Receipt.aggregate([
      {
        $match: {
          ...expenseQuery,
          createdAt: { $lt: startOfYear },
          uploadConfirmed: true,
        },
      },
      {
        $group: {
          _id: null,
          totalSizeBytes: { $sum: '$sizeBytes' },
        },
      },
    ]);
    
    const storageBeforeYearGB = storageBeforeYearResult[0]?.totalSizeBytes 
      ? storageBeforeYearResult[0].totalSizeBytes / (1024 * 1024 * 1024) 
      : 0;

    // Generate all 12 months for the selected year with cumulative storage
    let cumulativeStorage = storageBeforeYearGB;
    for (let month = 1; month <= 12; month++) {
      const key = `${year}-${month}`;
      const existingData = dataMap.get(key);
      
      if (existingData) {
        cumulativeStorage += existingData.totalSizeBytes / (1024 * 1024 * 1024); // Convert to GB
      }
      
      formattedStorageGrowth.push({
        name: monthNames[month - 1],
        value: parseFloat(cumulativeStorage.toFixed(2)),
        month,
        year,
      });
    }

    res.status(200).json({
      success: true,
      data: {
        storageGrowth: formattedStorageGrowth,
        totalStorageGB: parseFloat(totalStorageGB.toFixed(2)),
        totalStorageBytes: totalSizeBytes,
        year,
      },
    });
  });

  /**
   * Day-wise expense totals for a selected month (company-scoped for COMPANY_ADMIN).
   * GET /admin/analytics/expenses-daily?month=1&year=2026
   * Returns realtime data: one point per day (01 to last day of month) with amount and count.
   */
  static getExpensesDaily = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { Expense: ExpenseModel } = await import('../models/Expense');
    const { User } = await import('../models/User');
    const { CompanyAdmin } = await import('../models/CompanyAdmin');

    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
    const monthZero = Math.max(1, Math.min(12, month));
    const yearNum = Math.max(2020, Math.min(2100, year));

    let userIds: any[] = [];
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
      if (!companyAdmin || !companyAdmin.companyId) {
        return res.status(200).json({ success: true, data: { daily: [] } }) as any;
      }
      const companyUsers = await User.find({ companyId: companyAdmin.companyId }).select('_id').exec();
      userIds = companyUsers.map((u) => u._id);
    }
    if (userIds.length === 0) {
      return res.status(200).json({ success: true, data: { daily: [] } }) as any;
    }

    const startOfMonth = new Date(yearNum, monthZero - 1, 1);
    const endOfMonth = new Date(yearNum, monthZero, 0, 23, 59, 59, 999);

    const daily = await ExpenseModel.aggregate([
      {
        $match: {
          userId: { $in: userIds },
          expenseDate: { $gte: startOfMonth, $lte: endOfMonth },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$expenseDate' },
            month: { $month: '$expenseDate' },
            day: { $dayOfMonth: '$expenseDate' },
          },
          amount: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.day': 1 } },
    ]);

    const daysInMonth = new Date(yearNum, monthZero, 0).getDate();
    const byDay = new Map<number, { amount: number; count: number }>();
    for (let d = 1; d <= daysInMonth; d++) {
      byDay.set(d, { amount: 0, count: 0 });
    }
    daily.forEach((row: any) => {
      const day = row._id.day;
      byDay.set(day, { amount: row.amount, count: row.count });
    });

    const dailyArray = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const v = byDay.get(d)!;
      const dateStr = `${yearNum}-${String(monthZero).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      dailyArray.push({ date: dateStr, day: d, amount: v.amount, count: v.count });
    }

    res.status(200).json({
      success: true,
      data: { daily: dailyArray },
    });
  });

  /**
   * Day-wise OCR token consumption for a selected month (company-scoped for COMPANY_ADMIN).
   * GET /admin/analytics/ocr-daily?month=1&year=2026
   * Returns tokens consumed per day (from completed OCR jobs).
   */
  static getOcrUsageDaily = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { OcrJob } = await import('../models/OcrJob');
    const { User } = await import('../models/User');
    const { CompanyAdmin } = await import('../models/CompanyAdmin');

    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
    const monthZero = Math.max(1, Math.min(12, month));
    const yearNum = Math.max(2020, Math.min(2100, year));

    let userIds: any[] = [];
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
      if (!companyAdmin || !companyAdmin.companyId) {
        return res.status(200).json({ success: true, data: { daily: [] } }) as any;
      }
      const companyUsers = await User.find({ companyId: companyAdmin.companyId }).select('_id').exec();
      userIds = companyUsers.map((u) => u._id);
    }
    if (userIds.length === 0) {
      return res.status(200).json({ success: true, data: { daily: [] } }) as any;
    }

    const startOfMonth = new Date(yearNum, monthZero - 1, 1);
    const endOfMonth = new Date(yearNum, monthZero, 0, 23, 59, 59, 999);

    const daily = await OcrJob.aggregate([
      { $match: { status: 'COMPLETED', completedAt: { $gte: startOfMonth, $lte: endOfMonth } } },
      {
        $lookup: {
          from: 'receipts',
          localField: 'receiptId',
          foreignField: '_id',
          as: 'receipt',
        },
      },
      { $unwind: '$receipt' },
      {
        $lookup: {
          from: 'expenses',
          localField: 'receipt.expenseId',
          foreignField: '_id',
          as: 'expense',
        },
      },
      { $unwind: '$expense' },
      { $match: { 'expense.userId': { $in: userIds } } },
      {
        $group: {
          _id: {
            year: { $year: '$completedAt' },
            month: { $month: '$completedAt' },
            day: { $dayOfMonth: '$completedAt' },
          },
          tokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.day': 1 } },
    ]);

    const daysInMonth = new Date(yearNum, monthZero, 0).getDate();
    const byDay = new Map<number, { tokens: number; count: number }>();
    for (let d = 1; d <= daysInMonth; d++) {
      byDay.set(d, { tokens: 0, count: 0 });
    }
    daily.forEach((row: any) => {
      byDay.set(row._id.day, { tokens: row.tokens, count: row.count });
    });

    const dailyArray = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${yearNum}-${String(monthZero).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const v = byDay.get(d) || { tokens: 0, count: 0 };
      dailyArray.push({ date: dateStr, day: d, tokens: v.tokens, count: v.count });
    }

    res.status(200).json({
      success: true,
      data: { daily: dailyArray },
    });
  });

  // Insight Detection and Alerting
  static detectOCRSpike = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const { Expense: ExpenseModel } = await import('../models/Expense');
    // const { User } = await import('../models/User'); // Not used

    // Get recent OCR activity (last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const currentActivity = await ExpenseModel.find({
      createdAt: { $gte: oneHourAgo }
    }).countDocuments();

    // Get historical average (last 7 days, same hour)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const historicalActivity = await ExpenseModel.find({
      createdAt: { $gte: sevenDaysAgo, $lt: oneHourAgo }
    }).countDocuments();

    const hoursInWeek = 7 * 24;
    const historicalAverage = historicalActivity / hoursInWeek;

    // Check for spike
    const spikeThreshold = 3.0;
    const isSpike = currentActivity > historicalAverage * spikeThreshold;

    if (isSpike) {
      // Get company breakdown for spike
      const spikeExpenses = await ExpenseModel.find({
        createdAt: { $gte: oneHourAgo }
      }).populate('userId', 'companyId');

      const companyBreakdown: Record<string, number> = {};
      spikeExpenses.forEach((expense: any) => {
        const companyId = expense.userId?.companyId?.toString();
        if (companyId) {
          companyBreakdown[companyId] = (companyBreakdown[companyId] || 0) + 1;
        }
      });

      // Emit alerts for companies with spikes
      for (const [companyId, count] of Object.entries(companyBreakdown)) {
        if (count > historicalAverage * spikeThreshold) {
          emitSuperAdminEvent('ocr-spike-detected', {
            companyId,
            currentUsage: count,
            historicalAverage: Math.round(historicalAverage),
            severity: count > historicalAverage * 5 ? 'critical' : 'warning',
            timestamp: new Date()
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      data: {
        currentActivity,
        historicalAverage: Math.round(historicalAverage),
        isSpike,
        spikeThreshold
      }
    });
  });

  static detectAPIAbuse = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const { Expense: ExpenseModel } = await import('../models/Expense');
    const { User } = await import('../models/User');

    // Get recent API activity (last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const currentActivity = await ExpenseModel.find({
      createdAt: { $gte: fiveMinutesAgo }
    });

    // Group by user and company
    const userActivity: Record<string, number> = {};
    const companyActivity: Record<string, number> = {};

    for (const expense of currentActivity) {
      const userId = expense.userId.toString();
      const user = await User.findById(userId);
      const companyId = user?.companyId?.toString();

      userActivity[userId] = (userActivity[userId] || 0) + 1;
      if (companyId) {
        companyActivity[companyId] = (companyActivity[companyId] || 0) + 1;
      }
    }

    // Check for abuse patterns
    const abuseThreshold = 100; // requests per 5 minutes
    const abusiveUsers = Object.entries(userActivity)
      .filter(([_userId, count]) => (count as number) > abuseThreshold);

    const abusiveCompanies = Object.entries(companyActivity)
      .filter(([_companyId, count]) => (count as number) > abuseThreshold * 5); // Company threshold

    // Emit alerts
    abusiveUsers.forEach(([userId, count]: [string, number]) => {
      const user = currentActivity.find((exp: any) => exp.userId.toString() === userId)?.userId;
      if (user) {
        emitSuperAdminEvent('api-abuse-detected', {
          companyId: (user as any).companyId?.toString(),
          userId,
          requestCount: count,
          timeWindow: '5 minutes',
          severity: 'high',
          timestamp: new Date()
        });
      }
    });

    abusiveCompanies.forEach(([companyId, count]) => {
      emitSuperAdminEvent('api-abuse-detected', {
        companyId,
        requestCount: count,
        timeWindow: '5 minutes',
        severity: 'high',
        timestamp: new Date()
      });
    });

    res.status(200).json({
      success: true,
      data: {
        totalRequests: currentActivity.length,
        abusiveUsers: abusiveUsers.length,
        abusiveCompanies: abusiveCompanies.length,
        abuseThreshold
      }
    });
  });

  static checkStorageThresholds = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const { Receipt } = await import('../models/Receipt');
    // const { Expense: ExpenseModel } = await import('../models/Expense'); // Not used
    // const { User } = await import('../models/User'); // Not used

    // Get all companies with storage usage
    const storageUsage = await Receipt.aggregate([
      {
        $lookup: {
          from: 'expenses',
          localField: 'expenseId',
          foreignField: '_id',
          as: 'expense'
        }
      },
      { $unwind: '$expense' },
      {
        $lookup: {
          from: 'users',
          localField: 'expense.userId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      {
        $group: {
          _id: '$user.companyId',
          totalSizeBytes: { $sum: '$sizeBytes' },
          fileCount: { $sum: 1 }
        }
      }
    ]);

    const alerts: Array<{ companyId: any; usagePercent: number; usedGB: number; allocatedGB: number; severity: string }> = [];

    for (const company of storageUsage) {
      const companyId = company._id?.toString();
      if (!companyId) continue;

      const usedGB = company.totalSizeBytes / 1073741824;
      const allocatedGB = 50; // Mock - would come from company plan
      const usagePercent = (usedGB / allocatedGB) * 100;

      if (usagePercent > 90) {
        emitSuperAdminEvent('storage-threshold-warning', {
          companyId,
          usagePercent: Math.round(usagePercent),
          usedGB: Math.round(usedGB * 100) / 100,
          allocatedGB,
          severity: usagePercent > 95 ? 'critical' : 'warning',
          timestamp: new Date()
        });

        alerts.push({
          companyId,
          usagePercent: Math.round(usagePercent),
          usedGB: Math.round(usedGB * 100) / 100,
          allocatedGB,
          severity: usagePercent > 95 ? 'critical' : 'warning'
        });
      }
    }

    res.status(200).json({
      success: true,
      data: {
        checkedCompanies: storageUsage.length,
        alertsTriggered: alerts.length,
        alerts
      }
    });
  });

  // Cache Performance Monitoring
  static getCacheStats = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const stats = cacheService.getStats();

    res.status(200).json({
      success: true,
      data: {
        cacheEntries: stats.entries,
        cacheSizeBytes: stats.totalSize,
        cacheSizeMB: Math.round(stats.totalSize / 1024 / 1024 * 100) / 100
      }
    });
  });

  static clearCache = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const oldStats = cacheService.getStats();
    cacheService.clear();
    const newStats = cacheService.getStats();

    logger.info({
      oldEntries: oldStats.entries,
      oldSizeMB: Math.round(oldStats.totalSize / 1024 / 1024 * 100) / 100,
      newEntries: newStats.entries,
      newSizeMB: Math.round(newStats.totalSize / 1024 / 1024 * 100) / 100
    }, 'Cache cleared');

    res.status(200).json({
      success: true,
      message: 'Cache cleared successfully',
      data: {
        clearedEntries: oldStats.entries - newStats.entries,
        freedBytes: oldStats.totalSize - newStats.totalSize,
        freedMB: Math.round((oldStats.totalSize - newStats.totalSize) / 1024 / 1024 * 100) / 100
      }
    });
  });
}


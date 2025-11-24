import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ExpensesService } from '../services/expenses.service';
import { ExportService } from '../services/export.service';
import { ReportsService } from '../services/reports.service';
import { emitCompanyAdminDashboardUpdate } from '../socket/realtimeEvents';
import {
  reportFiltersSchema,
  expenseFiltersSchema,
  exportQuerySchema,
} from '../utils/dtoTypes';
import { ExpenseReportStatus, ExpenseStatus, ExportFormat } from '../utils/enums';

import { logger } from '@/config/logger';

export class AdminController {
  // Reports
  static getAllReports = asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = reportFiltersSchema.parse(req.query);
    const result = await ReportsService.adminGetReports(filters);

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  static approveReport = asyncHandler(async (req: AuthRequest, res: Response) => {
    const report = await ReportsService.adminChangeStatus(
      req.params.id,
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
    const report = await ReportsService.adminChangeStatus(
      req.params.id,
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

    const result = await ExportService.generateExport(req.params.id, format);

    res.status(200).json({
      success: true,
      data: {
        downloadUrl: result.downloadUrl,
        format,
      },
    });
  });

  // Expenses
  static getAllExpenses = asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = expenseFiltersSchema.parse(req.query);
    const result = await ExpensesService.adminListExpenses(filters);

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  static approveExpense = asyncHandler(async (req: AuthRequest, res: Response) => {
    const expense = await ExpensesService.adminChangeExpenseStatus(
      req.params.id,
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
    const expense = await ExpensesService.adminChangeExpenseStatus(
      req.params.id,
      ExpenseStatus.REJECTED,
      req.user!.id
    );

    res.status(200).json({
      success: true,
      data: expense,
      message: 'Expense rejected successfully',
    });
  });

  // Dashboard
  static getDashboard = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { ExpenseReport } = await import('../models/ExpenseReport');
    const { Expense: ExpenseModel } = await import('../models/Expense');
    const { User } = await import('../models/User');
    const { CompanyAdmin } = await import('../models/CompanyAdmin');

    // Build query filters based on user role
    let reportQuery: any = {};
    let expenseQuery: any = {};
    let userQuery: any = {};
    let companyId: string | undefined;

    // If user is COMPANY_ADMIN, filter by their company
    if (req.user!.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(req.user!.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
        
        // Get all user IDs in this company
        const companyUsers = await User.find({ companyId: companyAdmin.companyId })
          .select('_id')
          .exec();
        const userIds = companyUsers.map(u => u._id);

        // Filter reports and expenses by company users
        reportQuery = { userId: { $in: userIds } };
        expenseQuery = { userId: { $in: userIds } };
        userQuery = { companyId: companyAdmin.companyId };
      }
    }

    // Calculate date range for this month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    // Build month query for expenses
    const monthExpenseQuery = {
      ...expenseQuery,
      expenseDate: {
        $gte: startOfMonth,
        $lte: endOfMonth,
      },
    };

    const [
      totalReports,
      totalExpenses,
      pendingReports,
      approvedReports,
      totalAmount,
      totalAmountThisMonth,
      totalUsers,
    ] = await Promise.all([
      ExpenseReport.countDocuments(reportQuery),
      ExpenseModel.countDocuments(expenseQuery),
      ExpenseReport.countDocuments({ ...reportQuery, status: ExpenseReportStatus.SUBMITTED }),
      ExpenseReport.countDocuments({ ...reportQuery, status: ExpenseReportStatus.APPROVED }),
      ExpenseReport.aggregate([
        { $match: { ...reportQuery, status: ExpenseReportStatus.APPROVED } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
      ExpenseModel.aggregate([
        { $match: monthExpenseQuery },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.countDocuments(userQuery),
    ]);

    // Calculate user breakdown
    let employees = 0;
    let managers = 0;
    let businessHeads = 0;
    
    if (userQuery.companyId) {
      const companyUsers = await User.find(userQuery).select('role').exec();
      employees = companyUsers.filter(u => u.role === 'EMPLOYEE').length;
      managers = companyUsers.filter(u => u.role === 'MANAGER').length;
      businessHeads = companyUsers.filter(u => u.role === 'BUSINESS_HEAD').length;
    }

    const dashboardData = {
      totalReports,
      totalExpenses,
      pendingReports,
      approvedReports,
      totalAmount: totalAmount[0]?.total || 0,
      totalAmountThisMonth: totalAmountThisMonth[0]?.total || 0,
      totalUsers: totalUsers || 0,
      employees,
      managers,
      businessHeads,
    };

    // Emit real-time update if company admin
    if (req.user!.role === 'COMPANY_ADMIN' && companyId) {
      try {
        emitCompanyAdminDashboardUpdate(companyId, dashboardData);
      } catch (error) {
        // Don't fail the request if WebSocket emit fails
        logger.error({ error }, 'Error emitting company admin dashboard update');
      }
    }

    res.status(200).json({
      success: true,
      data: dashboardData,
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

    const totalStorageGB = totalStorageResult[0]?.totalSizeBytes 
      ? totalStorageResult[0].totalSizeBytes / (1024 * 1024 * 1024) 
      : 0;

    // Calculate cumulative storage - get total storage up to each month
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formattedStorageGrowth = [];
    
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
        year,
      },
    });
  });
}


import { Response } from 'express';
import { ReportsService } from '../services/reports.service';
import { ExpensesService } from '../services/expenses.service';
import { ExportService } from '../services/export.service';
import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import {
  reportFiltersSchema,
  expenseFiltersSchema,
  exportQuerySchema,
} from '../utils/dtoTypes';
import { ExpenseReportStatus, ExpenseStatus, ExportFormat } from '../utils/enums';

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
  static getDashboard = asyncHandler(async (_req: AuthRequest, res: Response) => {
    // Simple dashboard summary
    const { ExpenseReport } = await import('../models/ExpenseReport');
    const { Expense: ExpenseModel } = await import('../models/Expense');

    const [
      totalReports,
      totalExpenses,
      pendingReports,
      approvedReports,
      totalAmount,
    ] = await Promise.all([
      ExpenseReport.countDocuments(),
      ExpenseModel.countDocuments(),
      ExpenseReport.countDocuments({ status: ExpenseReportStatus.SUBMITTED }),
      ExpenseReport.countDocuments({ status: ExpenseReportStatus.APPROVED }),
      ExpenseReport.aggregate([
        { $match: { status: ExpenseReportStatus.APPROVED } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalReports,
        totalExpenses,
        pendingReports,
        approvedReports,
        totalAmount: totalAmount[0]?.total || 0,
      },
    });
  });
}


import mongoose from 'mongoose';

import { Expense, IExpense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { emitCompanyAdminDashboardUpdate } from '../socket/realtimeEvents';
import { CreateExpenseDto, UpdateExpenseDto, ExpenseFiltersDto } from '../utils/dtoTypes';
import { ExpenseStatus, ExpenseReportStatus , AuditAction } from '../utils/enums';
import { getPaginationOptions, createPaginatedResult } from '../utils/pagination';

import { AuditService } from './audit.service';
import { CompanyAdminDashboardService } from './companyAdminDashboard.service';
import { ReportsService } from './reports.service';

import { logger } from '@/config/logger';

export class ExpensesService {
  static async createExpense(
    reportId: string,
    userId: string,
    data: CreateExpenseDto
  ): Promise<IExpense> {
    const report = await ExpenseReport.findById(reportId);

    if (!report) {
      throw new Error('Report not found');
    }

    if (report.userId.toString() !== userId) {
      throw new Error('Access denied');
    }

    // Allow adding expenses if report is DRAFT or CHANGES_REQUESTED
    if (report.status !== ExpenseReportStatus.DRAFT && report.status !== ExpenseReportStatus.CHANGES_REQUESTED) {
      throw new Error('Can only add expenses to draft reports or reports with changes requested');
    }

    // Prepare receipt IDs array - link to source document if provided
    const receiptIds: mongoose.Types.ObjectId[] = [];
    if (data.receiptId) {
      receiptIds.push(new mongoose.Types.ObjectId(data.receiptId));
    }

    const expense = new Expense({
      reportId,
      userId: new mongoose.Types.ObjectId(userId),
      vendor: data.vendor,
      categoryId: data.categoryId ? new mongoose.Types.ObjectId(data.categoryId) : undefined,
      projectId: data.projectId ? new mongoose.Types.ObjectId(data.projectId) : undefined,
      amount: data.amount,
      currency: data.currency || 'INR',
      expenseDate: new Date(data.expenseDate),
      status: ExpenseStatus.DRAFT,
      source: data.source,
      notes: data.notes,
      receiptIds,
      receiptPrimaryId: data.receiptId ? new mongoose.Types.ObjectId(data.receiptId) : undefined,
    });

    const saved = await expense.save();

    // Recalculate report total
    await ReportsService.recalcTotals(reportId);

    await AuditService.log(
      userId,
      'Expense',
      (saved._id as mongoose.Types.ObjectId).toString(),
      AuditAction.CREATE
    );

    // Emit company admin dashboard update if user has a company
    try {
      const user = await User.findById(userId).select('companyId').exec();
      if (user && user.companyId) {
        const companyId = user.companyId.toString();
        const stats = await CompanyAdminDashboardService.getDashboardStatsForCompany(companyId);
        emitCompanyAdminDashboardUpdate(companyId, stats);
      }
    } catch (error) {
      // Don't fail expense creation if dashboard update fails
      logger.error({ error }, 'Error emitting company admin dashboard update');
    }

    return saved;
  }

  static async updateExpense(
    id: string,
    userId: string,
    data: UpdateExpenseDto
  ): Promise<IExpense> {
    const expense = await Expense.findById(id).populate('reportId');

    if (!expense) {
      throw new Error('Expense not found');
    }

    const report = expense.reportId as any;

    if (report.userId.toString() !== userId) {
      throw new Error('Access denied');
    }

    // Allow updating expenses if:
    // 1. Report is DRAFT, OR
    // 2. Report is CHANGES_REQUESTED (employee can modify report), OR
    // 3. Expense status is PENDING (changes requested), OR
    // 4. Expense status is REJECTED (employee can fix rejected expenses)
    const canUpdate = 
      report.status === ExpenseReportStatus.DRAFT || 
      report.status === ExpenseReportStatus.CHANGES_REQUESTED ||
      expense.status === ExpenseStatus.PENDING || 
      expense.status === ExpenseStatus.REJECTED;

    if (!canUpdate) {
      throw new Error('Can only update expenses in draft reports, reports with changes requested, or expenses with pending/rejected status');
    }

    if (data.vendor !== undefined) {
      expense.vendor = data.vendor;
    }

    if (data.categoryId !== undefined) {
      expense.categoryId = data.categoryId ? new mongoose.Types.ObjectId(data.categoryId) : undefined;
    }

    if (data.projectId !== undefined) {
      expense.projectId = data.projectId ? new mongoose.Types.ObjectId(data.projectId) : undefined;
    }

    if (data.amount !== undefined) {
      expense.amount = data.amount;
    }

    if (data.currency !== undefined) {
      expense.currency = data.currency;
    }

    if (data.expenseDate !== undefined) {
      expense.expenseDate = new Date(data.expenseDate);
    }

    if (data.notes !== undefined) {
      expense.notes = data.notes;
    }

    // If expense status was PENDING or REJECTED, update it back to DRAFT
    // This indicates the employee has made the requested changes
    if (expense.status === ExpenseStatus.PENDING || expense.status === ExpenseStatus.REJECTED) {
      expense.status = ExpenseStatus.DRAFT;
      // Clear manager feedback since employee has addressed the issue
      expense.managerComment = undefined;
      expense.managerAction = undefined;
      expense.managerActionAt = undefined;
    }

    const saved = await expense.save();

    // Recalculate report total
    await ReportsService.recalcTotals(report._id.toString());

    await AuditService.log(userId, 'Expense', id, AuditAction.UPDATE, data);

    // Emit real-time event if report is SUBMITTED (so manager can see the update)
    if (report.status === ExpenseReportStatus.SUBMITTED) {
      try {
        const reportUser = await User.findById(report.userId).select('managerId companyId').exec();
        if (reportUser && reportUser.managerId) {
          const { emitManagerReportUpdate } = await import('../socket/realtimeEvents');
          const populatedReport = await ExpenseReport.findById(report._id)
            .populate('userId', 'name email')
            .populate('projectId', 'name code')
            .exec();
          
          if (populatedReport) {
            emitManagerReportUpdate(reportUser.managerId.toString(), 'EXPENSE_UPDATED', populatedReport.toObject());
          }
        }
      } catch (error) {
        logger.error({ error }, 'Error emitting expense update event');
        // Don't fail expense update if real-time event fails
      }
    }

    return saved;
  }

  static async getExpenseById(
    id: string,
    requestingUserId: string,
    requestingUserRole: string
  ): Promise<IExpense | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }

    const expense = await Expense.findById(id)
      .populate('reportId')
      .populate('categoryId', 'name code')
      .populate('receiptPrimaryId')
      .exec();

    if (!expense) {
      return null;
    }

    const report = expense.reportId as any;

    // Check access
    if (
      report.userId.toString() !== requestingUserId &&
      requestingUserRole !== 'ADMIN' &&
      requestingUserRole !== 'BUSINESS_HEAD'
    ) {
      throw new Error('Access denied');
    }

    return expense;
  }

  static async listExpensesForUser(
    userId: string,
    filters: ExpenseFiltersDto
  ): Promise<any> {
    const { page, pageSize } = getPaginationOptions(filters.page, filters.pageSize);

    // Build base query - expenses must belong to the user
    // Since expenses have a userId field, we can directly query by userId
    // This ensures all expenses created by the user (from phone or web) are included
    const query: any = {
      userId: new mongoose.Types.ObjectId(userId),
    };

    // Filter by specific reportId if provided
    if (filters.reportId) {
      query.reportId = new mongoose.Types.ObjectId(filters.reportId);
    }
    // Otherwise, show all expenses for the user (regardless of reportId)
    // This ensures expenses from phone and web are both visible

    // Status filter
    if (filters.status) {
      query.status = filters.status.toUpperCase();
    }

    // Category filter
    if (filters.categoryId) {
      query.categoryId = filters.categoryId;
    }

    // Date range filters
    if (filters.from || filters.to) {
      query.expenseDate = {};
      if (filters.from) {
        query.expenseDate.$gte = new Date(filters.from);
      }
      if (filters.to) {
        query.expenseDate.$lte = new Date(filters.to);
      }
    }

    // Search query - add as $and condition to preserve existing $or
    if (filters.q) {
      const searchConditions = {
        $or: [
          { vendor: { $regex: filters.q, $options: 'i' } },
          { notes: { $regex: filters.q, $options: 'i' } },
        ]
      };
      
      if (query.$or) {
        // Combine with existing $or using $and
        query.$and = [
          { $or: query.$or },
          searchConditions
        ];
        delete query.$or;
      } else {
        // No existing $or, just add search conditions
        query.$or = searchConditions.$or;
      }
    }

    const skip = (page - 1) * pageSize;

    const [expenses, total] = await Promise.all([
      Expense.find(query)
        .populate('reportId', 'name status')
        .populate('categoryId', 'name code')
        .sort({ expenseDate: -1 })
        .skip(skip)
        .limit(pageSize)
        .exec(),
      Expense.countDocuments(query).exec(),
    ]);

    return createPaginatedResult(expenses, total, page, pageSize);
  }

  static async adminListExpenses(filters: ExpenseFiltersDto): Promise<any> {
    const { page, pageSize } = getPaginationOptions(filters.page, filters.pageSize);
    const query: any = {};

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.categoryId) {
      query.categoryId = filters.categoryId;
    }

    if (filters.reportId) {
      query.reportId = filters.reportId;
    }

    if (filters.from) {
      query.expenseDate = { ...query.expenseDate, $gte: new Date(filters.from) };
    }

    if (filters.to) {
      query.expenseDate = { ...query.expenseDate, $lte: new Date(filters.to) };
    }

    if (filters.q) {
      query.$or = [
        { vendor: { $regex: filters.q, $options: 'i' } },
        { notes: { $regex: filters.q, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * pageSize;

    const [expenses, total] = await Promise.all([
      Expense.find(query)
        .populate('reportId', 'name status userId')
        .populate('categoryId', 'name code')
        .sort({ expenseDate: -1 })
        .skip(skip)
        .limit(pageSize)
        .exec(),
      Expense.countDocuments(query).exec(),
    ]);

    return createPaginatedResult(expenses, total, page, pageSize);
  }

  static async adminChangeExpenseStatus(
    id: string,
    newStatus: ExpenseStatus.APPROVED | ExpenseStatus.REJECTED,
    adminUserId: string
  ): Promise<IExpense> {
    const expense = await Expense.findById(id);

    if (!expense) {
      throw new Error('Expense not found');
    }

    if (expense.status === ExpenseStatus.APPROVED || expense.status === ExpenseStatus.REJECTED) {
      throw new Error('Expense already finalized');
    }

    expense.status = newStatus;
    const saved = await expense.save();

    await AuditService.log(
      adminUserId,
      'Expense',
      id,
      AuditAction.STATUS_CHANGE,
      { status: newStatus }
    );

    return saved;
  }

  static async deleteExpense(
    id: string,
    userId: string,
    userRole: string
  ): Promise<void> {
    const expense = await Expense.findById(id).populate('reportId');

    if (!expense) {
      throw new Error('Expense not found');
    }

    const report = expense.reportId as any;

    // Check access: owner or admin
    if (
      report.userId.toString() !== userId &&
      userRole !== 'ADMIN' &&
      userRole !== 'BUSINESS_HEAD'
    ) {
      throw new Error('Access denied');
    }

    // Only allow deletion if:
    // 1. Report is DRAFT, OR
    // 2. Report is CHANGES_REQUESTED (employee can modify report), OR
    // 3. Expense is REJECTED (employee can delete rejected expenses and resubmit)
    const canDelete = 
      report.status === ExpenseReportStatus.DRAFT || 
      report.status === ExpenseReportStatus.CHANGES_REQUESTED ||
      expense.status === ExpenseStatus.REJECTED;

    if (report.userId.toString() === userId && !canDelete) {
      throw new Error('Can only delete expenses from draft reports, reports with changes requested, or rejected expenses');
    }

    const reportId = report._id.toString();

    // Delete the expense
    await Expense.findByIdAndDelete(id);

    // Recalculate report total
    await ReportsService.recalcTotals(reportId);

    await AuditService.log(userId, 'Expense', id, AuditAction.DELETE);
  }
}


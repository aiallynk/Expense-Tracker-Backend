import { Expense, IExpense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { CreateExpenseDto, UpdateExpenseDto, ExpenseFiltersDto } from '../utils/dtoTypes';
import { ExpenseStatus, ExpenseReportStatus } from '../utils/enums';
import { getPaginationOptions, createPaginatedResult } from '../utils/pagination';
import mongoose from 'mongoose';
import { AuditService } from './audit.service';
import { AuditAction } from '../utils/enums';
import { ReportsService } from './reports.service';

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

    if (report.status !== ExpenseReportStatus.DRAFT) {
      throw new Error('Can only add expenses to draft reports');
    }

    const expense = new Expense({
      reportId,
      vendor: data.vendor,
      categoryId: data.categoryId,
      amount: data.amount,
      currency: data.currency || 'INR',
      expenseDate: new Date(data.expenseDate),
      status: ExpenseStatus.DRAFT,
      source: data.source,
      notes: data.notes,
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

    if (report.status !== ExpenseReportStatus.DRAFT) {
      throw new Error('Can only update expenses in draft reports');
    }

    if (data.vendor !== undefined) {
      expense.vendor = data.vendor;
    }

    if (data.categoryId !== undefined) {
      expense.categoryId = new mongoose.Types.ObjectId(data.categoryId);
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

    const saved = await expense.save();

    // Recalculate report total
    await ReportsService.recalcTotals(report._id.toString());

    await AuditService.log(userId, 'Expense', id, AuditAction.UPDATE, data);

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

    // Get user's reports
    const userReports = await ExpenseReport.find({ userId }).select('_id');
    const reportIds = userReports.map((r) => r._id);

    const query: any = { reportId: { $in: reportIds } };

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
}


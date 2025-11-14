import {
  ExpenseReport,
  IExpenseReport,
} from '../models/ExpenseReport';
import { Expense } from '../models/Expense';
import { CreateReportDto, UpdateReportDto, ReportFiltersDto } from '../utils/dtoTypes';
import { ExpenseReportStatus } from '../utils/enums';
import { getPaginationOptions, createPaginatedResult } from '../utils/pagination';
import mongoose from 'mongoose';
import { AuditService } from './audit.service';
import { AuditAction } from '../utils/enums';
import { NotificationService } from './notification.service';

export class ReportsService {
  static async createReport(
    userId: string,
    data: CreateReportDto
  ): Promise<IExpenseReport> {
    const report = new ExpenseReport({
      userId,
      projectId: data.projectId,
      name: data.name,
      notes: data.notes,
      fromDate: new Date(data.fromDate),
      toDate: new Date(data.toDate),
      status: ExpenseReportStatus.DRAFT,
    });

    const saved = await report.save();

    await AuditService.log(
      userId,
      'ExpenseReport',
      (saved._id as mongoose.Types.ObjectId).toString(),
      AuditAction.CREATE
    );

    return saved;
  }

  static async getReportsForUser(
    userId: string,
    filters: ReportFiltersDto
  ): Promise<any> {
    const { page, pageSize } = getPaginationOptions(filters.page, filters.pageSize);
    const query: any = { userId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.projectId) {
      query.projectId = filters.projectId;
    }

    if (filters.from) {
      query.fromDate = { $gte: new Date(filters.from) };
    }

    if (filters.to) {
      query.toDate = { $lte: new Date(filters.to) };
    }

    const skip = (page - 1) * pageSize;

    const [reports, total] = await Promise.all([
      ExpenseReport.find(query)
        .populate('projectId', 'name code')
        .populate('userId', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .exec(),
      ExpenseReport.countDocuments(query).exec(),
    ]);

    return createPaginatedResult(reports, total, page, pageSize);
  }

  static async getReportById(
    id: string,
    requestingUserId: string,
    requestingUserRole: string
  ): Promise<IExpenseReport | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }

    const report = await ExpenseReport.findById(id)
      .populate('projectId', 'name code')
      .populate('userId', 'name email')
      .populate('updatedBy', 'name email')
      .exec();

    if (!report) {
      return null;
    }

    // Check access: owner or admin
    if (
      report.userId.toString() !== requestingUserId &&
      requestingUserRole !== 'ADMIN' &&
      requestingUserRole !== 'BUSINESS_HEAD'
    ) {
      throw new Error('Access denied');
    }

    return report;
  }

  static async updateReport(
    id: string,
    userId: string,
    data: UpdateReportDto
  ): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(id);

    if (!report) {
      throw new Error('Report not found');
    }

    if (report.userId.toString() !== userId) {
      throw new Error('Access denied');
    }

    if (report.status !== ExpenseReportStatus.DRAFT) {
      throw new Error('Only draft reports can be updated');
    }

    if (data.name !== undefined) {
      report.name = data.name;
    }

    if (data.notes !== undefined) {
      report.notes = data.notes;
    }

    if (data.projectId !== undefined) {
      report.projectId = data.projectId ? new mongoose.Types.ObjectId(data.projectId) : undefined;
    }

    if (data.fromDate !== undefined) {
      report.fromDate = new Date(data.fromDate);
    }

    if (data.toDate !== undefined) {
      report.toDate = new Date(data.toDate);
    }

    report.updatedBy = new mongoose.Types.ObjectId(userId);

    const saved = await report.save();

    await AuditService.log(
      userId,
      'ExpenseReport',
      id,
      AuditAction.UPDATE,
      data
    );

    return saved;
  }

  static async submitReport(id: string, userId: string): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(id);

    if (!report) {
      throw new Error('Report not found');
    }

    if (report.userId.toString() !== userId) {
      throw new Error('Access denied');
    }

    if (report.status !== ExpenseReportStatus.DRAFT) {
      throw new Error('Only draft reports can be submitted');
    }

    // Validate: must have at least one expense
    const expenseCount = await Expense.countDocuments({ reportId: id });
    if (expenseCount === 0) {
      throw new Error('Report must have at least one expense');
    }

    report.status = ExpenseReportStatus.SUBMITTED;
    report.submittedAt = new Date();
    report.updatedBy = new mongoose.Types.ObjectId(userId);

    const saved = await report.save();

    await AuditService.log(
      userId,
      'ExpenseReport',
      id,
      AuditAction.STATUS_CHANGE,
      { status: ExpenseReportStatus.SUBMITTED }
    );

    // Notify admins
    await NotificationService.notifyReportSubmitted(saved);

    return saved;
  }

  static async adminGetReports(filters: ReportFiltersDto): Promise<any> {
    const { page, pageSize } = getPaginationOptions(filters.page, filters.pageSize);
    const query: any = {};

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.userId) {
      query.userId = filters.userId;
    }

    if (filters.projectId) {
      query.projectId = filters.projectId;
    }

    if (filters.from) {
      query.fromDate = { $gte: new Date(filters.from) };
    }

    if (filters.to) {
      query.toDate = { $lte: new Date(filters.to) };
    }

    const skip = (page - 1) * pageSize;

    const [reports, total] = await Promise.all([
      ExpenseReport.find(query)
        .populate('projectId', 'name code')
        .populate('userId', 'name email')
        .populate('updatedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .exec(),
      ExpenseReport.countDocuments(query).exec(),
    ]);

    return createPaginatedResult(reports, total, page, pageSize);
  }

  static async adminChangeStatus(
    id: string,
    newStatus: ExpenseReportStatus.APPROVED | ExpenseReportStatus.REJECTED,
    adminUserId: string
  ): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(id);

    if (!report) {
      throw new Error('Report not found');
    }

    if (report.status !== ExpenseReportStatus.SUBMITTED) {
      throw new Error('Only submitted reports can be approved/rejected');
    }

    report.status = newStatus;
    report.updatedBy = new mongoose.Types.ObjectId(adminUserId);

    if (newStatus === ExpenseReportStatus.APPROVED) {
      report.approvedAt = new Date();
    } else {
      report.rejectedAt = new Date();
    }

    const saved = await report.save();

    await AuditService.log(
      adminUserId,
      'ExpenseReport',
      id,
      AuditAction.STATUS_CHANGE,
      { status: newStatus }
    );

    // Notify employee
    await NotificationService.notifyReportStatusChanged(saved, newStatus);

    return saved;
  }

  static async recalcTotals(reportId: string): Promise<void> {
    const expenses = await Expense.find({ reportId });
    const totalAmount = expenses.reduce((sum, exp) => sum + exp.amount, 0);

    await ExpenseReport.findByIdAndUpdate(reportId, { totalAmount });
  }
}


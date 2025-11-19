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
import { logger } from '../utils/logger';

export class ReportsService {
  static async createReport(
    userId: string,
    data: CreateReportDto
  ): Promise<IExpenseReport> {
    logger.info('ReportsService.createReport - Starting report creation');
    logger.debug('User ID:', userId);
    logger.debug('Report data:', {
      name: data.name,
      projectId: data.projectId || 'none',
      fromDate: data.fromDate,
      toDate: data.toDate,
      notes: data.notes || 'none',
    });

    try {
      // Validate projectId - if provided, it must be a valid ObjectId
      // If it's not a valid ObjectId (e.g., user typed a name), ignore it
      let projectId: mongoose.Types.ObjectId | undefined = undefined;
      if (data.projectId && data.projectId.trim() !== '') {
        if (mongoose.Types.ObjectId.isValid(data.projectId)) {
          projectId = new mongoose.Types.ObjectId(data.projectId);
          logger.debug('Valid projectId provided:', projectId);
        } else {
          logger.warn('Invalid projectId provided (not a valid ObjectId), ignoring:', data.projectId);
          // Don't throw error, just ignore invalid projectId
        }
      }

      const report = new ExpenseReport({
        userId,
        projectId: projectId,
        name: data.name,
        notes: data.notes,
        fromDate: new Date(data.fromDate),
        toDate: new Date(data.toDate),
        status: ExpenseReportStatus.DRAFT,
      });

      logger.info('ExpenseReport model instance created');
      logger.debug('Report instance:', {
        userId: report.userId,
        name: report.name,
        fromDate: report.fromDate,
        toDate: report.toDate,
        status: report.status,
      });

      logger.info('Saving report to database (expensereports collection)...');
      const saved = await report.save();
      logger.info('Report saved successfully to expensereports collection');
      logger.info('Saved report ID:', saved._id);
      logger.info('Saved report details:', {
        _id: saved._id,
        name: saved.name,
        status: saved.status,
        userId: saved.userId,
        fromDate: saved.fromDate,
        toDate: saved.toDate,
        createdAt: saved.createdAt,
      });

      logger.info('Creating audit log...');
      await AuditService.log(
        userId,
        'ExpenseReport',
        (saved._id as mongoose.Types.ObjectId).toString(),
        AuditAction.CREATE
      );
      logger.info('Audit log created successfully');

      logger.info('ReportsService.createReport - Report creation completed successfully');
      return saved;
    } catch (error: any) {
      logger.error('ReportsService.createReport - Error creating report:', error);
      logger.error('Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw error;
    }
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

    // Get expenses count for each report
    let reportsWithExpenses: any[] = reports.map((r) => r.toObject());
    
    if (reports.length > 0) {
      const reportIds = reports.map((r) => r._id as mongoose.Types.ObjectId);
      const expensesCounts = await Expense.aggregate([
        { $match: { reportId: { $in: reportIds } } },
        { $group: { _id: '$reportId', count: { $sum: 1 } } },
      ]);

      // Create a map of reportId -> expenses count
      const expensesCountMap = new Map<string, number>();
      expensesCounts.forEach((item) => {
        const reportId = item._id instanceof mongoose.Types.ObjectId 
          ? item._id.toString() 
          : String(item._id);
        expensesCountMap.set(reportId, item.count);
      });

      // Add expenses count to each report
      reportsWithExpenses = reports.map((report) => {
        const reportObj = report.toObject();
        const reportId = (report._id as mongoose.Types.ObjectId).toString();
        const expensesCount = expensesCountMap.get(reportId) || 0;
        return {
          ...reportObj,
          expensesCount,
          expenses: [], // Empty array for compatibility, but we have the count
        };
      });
    }

    return createPaginatedResult(reportsWithExpenses, total, page, pageSize);
  }

  static async getReportById(
    id: string,
    requestingUserId: string,
    requestingUserRole: string
  ): Promise<any> {
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
    // Handle both populated and non-populated userId
    let reportUserId: string;
    const userIdValue: any = report.userId;
    
    if (userIdValue && typeof userIdValue === 'object') {
      // Check if it's a populated document (has _id property)
      if ('_id' in userIdValue && userIdValue._id) {
        // userId is populated (Mongoose document)
        reportUserId = userIdValue._id.toString();
      } else if (userIdValue instanceof mongoose.Types.ObjectId) {
        // userId is an ObjectId
        reportUserId = userIdValue.toString();
      } else {
        // Fallback: try to get id or _id property
        reportUserId = userIdValue.id?.toString() || userIdValue._id?.toString() || String(userIdValue);
      }
    } else {
      // userId is a string or primitive
      reportUserId = String(userIdValue);
    }
    
    const requestingUserIdStr = String(requestingUserId);
    
    logger.debug('Checking report access', {
      reportId: id,
      reportUserId,
      requestingUserId: requestingUserIdStr,
      requestingUserRole,
      userIdType: typeof userIdValue,
      userIdIsObject: typeof userIdValue === 'object',
    });
    
    if (
      reportUserId !== requestingUserIdStr &&
      requestingUserRole !== 'ADMIN' &&
      requestingUserRole !== 'BUSINESS_HEAD'
    ) {
      logger.warn('Access denied to report', {
        reportId: id,
        reportUserId,
        requestingUserId: requestingUserIdStr,
        requestingUserRole,
      });
      throw new Error('Access denied');
    }

    // Get all expenses for this report with receipts and categories
    const expenses = await Expense.find({ reportId: id })
      .populate('categoryId', 'name code')
      .populate({
        path: 'receiptPrimaryId',
        select: 'storageUrl storageKey mimeType thumbnailUrl ocrJobId',
        populate: {
          path: 'ocrJobId',
          select: 'status resultJson errorJson completedAt',
        },
      })
      .sort({ expenseDate: -1 })
      .exec();

    // Convert to plain object and add expenses
    const reportObj = report.toObject();
    return {
      ...reportObj,
      expenses,
    };
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


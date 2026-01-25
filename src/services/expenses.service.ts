import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { Expense, IExpense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { emitCompanyAdminDashboardUpdate } from '../socket/realtimeEvents';
import { getUserCompanyId, getCompanyUserIds } from '../utils/companyAccess';
import { CreateExpenseDto, UpdateExpenseDto, ExpenseFiltersDto } from '../utils/dtoTypes';
import { ExpenseStatus, ExpenseReportStatus , AuditAction } from '../utils/enums';
import { getPaginationOptions, createPaginatedResult } from '../utils/pagination';

import { AuditService } from './audit.service';
import { CompanyAdminDashboardService } from './companyAdminDashboard.service';
import { ProjectStakeholderService } from './projectStakeholder.service';
import { ReportsService } from './reports.service';
import { CompanySettingsService } from './companySettings.service';
import { currencyService } from './currency.service';

import { logger } from '@/config/logger';
import { config } from '@/config/index';
import { DateUtils } from '@/utils/dateUtils';

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

    const invoiceDate = data.invoiceDate ? DateUtils.frontendDateToBackend(data.invoiceDate) : undefined;
    let invoiceFingerprint: string | undefined = undefined;
    // Keep fingerprint for legacy indexes; duplicate detection is flag-only via DuplicateDetectionService
    if (data.invoiceId && invoiceDate) {
      const { DuplicateInvoiceService } = await import('./duplicateInvoice.service');
      const originalAmount = data.amount;
      invoiceFingerprint = DuplicateInvoiceService.computeFingerprint(
        data.invoiceId,
        data.vendor,
        invoiceDate,
        originalAmount
      );
    }

    // Rule 1: Detect original currency (from OCR, manual input, or existing expense)
    const originalCurrency = (data.currency || 'INR').toUpperCase();
    const originalAmount = data.amount;

    // Validate project access if projectId is provided
    if (data.projectId) {
      const user = await User.findById(userId).select('companyId').exec();
      if (!user || !user.companyId) {
        throw new Error('User company not found');
      }

      const userProjects = await ProjectStakeholderService.getUserProjects(userId, user.companyId.toString());
      const hasAccess = userProjects.some((project: any) => (project._id as any).toString() === data.projectId);

      if (!hasAccess) {
        throw new Error('Access denied: You do not have permission to assign expenses to this project');
      }
    }

    // Rule 2: Get company's selected currency (needed for advance validation)
    const selectedCurrency = await this.getCompanySelectedCurrency(userId);

    // Validate advance application (use original amount for validation before conversion)
    if ((data.advanceAppliedAmount ?? 0) > 0) {
      const adv = Number(data.advanceAppliedAmount);
      if (!isFinite(adv) || adv < 0) {
        throw new Error('Invalid advanceAppliedAmount');
      }
      // Note: We'll validate against converted amount after conversion
    }

    // Expense date must be within report [fromDate, toDate] (plan §4.1)
    const expenseDateBackend = DateUtils.frontendDateToBackend(data.expenseDate);
    if (!DateUtils.isDateInReportRange(expenseDateBackend, report.fromDate, report.toDate)) {
      throw new Error(
        `Expense date must be within report date range (${DateUtils.backendDateToFrontend(report.fromDate)} to ${DateUtils.backendDateToFrontend(report.toDate)})`
      );
    }

    // Rule 3 & 4: Process currency conversion
    const conversionMetadata = await this.processCurrencyConversion(
      originalAmount,
      originalCurrency,
      selectedCurrency
    );

    // Rule 5: Store expense with converted amount and metadata
    // ALWAYS store amount in selected currency (Rule 3: NEVER store in original currency if different)
    const expense = new Expense({
      reportId,
      userId: new mongoose.Types.ObjectId(userId),
      vendor: data.vendor,
      categoryId: data.categoryId ? new mongoose.Types.ObjectId(data.categoryId) : undefined,
      costCentreId: data.costCentreId ? new mongoose.Types.ObjectId(data.costCentreId) : undefined,
      projectId: data.projectId ? new mongoose.Types.ObjectId(data.projectId) : undefined,
      // Store converted amount in selected currency (Rule 3)
      amount: conversionMetadata.convertedAmount,
      currency: selectedCurrency, // Always store in selected currency
      expenseDate: expenseDateBackend,
      status: ExpenseStatus.DRAFT,
      source: data.source,
      notes: data.notes,
      receiptIds,
      receiptPrimaryId: data.receiptId ? new mongoose.Types.ObjectId(data.receiptId) : undefined,
      // Invoice fields
      invoiceId: data.invoiceId,
      invoiceDate,
      invoiceFingerprint,
      // Advance cash (use converted amount for advance validation)
      advanceAppliedAmount: data.advanceAppliedAmount ?? 0,
      advanceCurrency: selectedCurrency,
      // Rule 5: Currency conversion metadata
      conversionApplied: conversionMetadata.conversionApplied,
      originalAmount: conversionMetadata.originalAmount,
      originalCurrency: conversionMetadata.originalCurrency,
      convertedAmount: conversionMetadata.convertedAmount,
      selectedCurrency: conversionMetadata.selectedCurrency,
      exchangeRateUsed: conversionMetadata.exchangeRateUsed,
      exchangeRateDate: conversionMetadata.exchangeRateDate,
    });

    // Validate advance against converted amount
    if (expense.advanceAppliedAmount && expense.advanceAppliedAmount > expense.amount) {
      throw new Error('advanceAppliedAmount cannot exceed expense amount');
    }

    const saved = await expense.save();

    // Recalculate report total
    await ReportsService.recalcTotals(reportId);

    // Duplicate detection: flag-only, never block (updates expense.duplicateFlag / duplicateReason)
    try {
      const { DuplicateDetectionService } = await import('./duplicateDetection.service');
      const user = await User.findById(userId).select('companyId').exec();
      const companyId = user?.companyId as mongoose.Types.ObjectId | undefined;
      await DuplicateDetectionService.runDuplicateCheck(
        (saved._id as mongoose.Types.ObjectId).toString(),
        companyId
      );
    } catch (e) {
      logger.warn({ err: e, expenseId: saved._id }, 'Duplicate check failed; continuing');
    }

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

    // Refetch to include duplicateFlag / duplicateReason set by DuplicateDetectionService
    const updated = await Expense.findById(saved._id).exec();
    const out = (updated ?? saved).toObject();
    return {
      ...out,
      expenseDate: (updated ?? saved).expenseDate
        ? DateUtils.backendDateToFrontend((updated ?? saved).expenseDate!)
        : (out as any).expenseDate,
      invoiceDate: (updated ?? saved).invoiceDate
        ? DateUtils.backendDateToFrontend((updated ?? saved).invoiceDate!)
        : (out as any).invoiceDate,
    } as any;
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

    const priorCategoryId = expense.categoryId?.toString?.();
    const priorExpenseDate = expense.expenseDate ? DateUtils.backendDateToFrontend(expense.expenseDate) : null;

    if (data.vendor !== undefined) {
      expense.vendor = data.vendor;
    }

    if (data.categoryId !== undefined) {
      expense.categoryId = data.categoryId ? new mongoose.Types.ObjectId(data.categoryId) : undefined;
    }

    if (data.costCentreId !== undefined) {
      // Handle null explicitly to allow clearing cost centre
      expense.costCentreId = data.costCentreId ? new mongoose.Types.ObjectId(data.costCentreId) : undefined;
    }

    if (data.projectId !== undefined) {
      // Validate project access if projectId is being set
      if (data.projectId) {
        const user = await User.findById(userId).select('companyId').exec();
        if (!user || !user.companyId) {
          throw new Error('User company not found');
        }

        const userProjects = await ProjectStakeholderService.getUserProjects(userId, user.companyId.toString());
        const hasAccess = userProjects.some((project: any) => (project._id as any).toString() === data.projectId);

        if (!hasAccess) {
          throw new Error('Access denied: You do not have permission to assign expenses to this project');
        }
      }
      expense.projectId = data.projectId ? new mongoose.Types.ObjectId(data.projectId) : undefined;
    }

    // Rule 8: Re-evaluate conversion if amount or currency changes
    // Only process conversion if amount or currency is being updated
    if (data.amount !== undefined || data.currency !== undefined) {
      // Rule 1: Detect original currency (from updated data or existing expense)
      const originalCurrency = data.currency 
        ? data.currency.toUpperCase() 
        : (expense.originalCurrency || expense.currency || 'INR').toUpperCase();
      const originalAmount = data.amount !== undefined 
        ? data.amount 
        : (expense.originalAmount || expense.amount || 0);

      // Rule 2: Get company's selected currency
      const selectedCurrency = await this.getCompanySelectedCurrency(userId);

      // Rule 3 & 4: Process currency conversion from scratch
      const conversionMetadata = await this.processCurrencyConversion(
        originalAmount,
        originalCurrency,
        selectedCurrency
      );

      // Rule 5: Update conversion metadata
      expense.conversionApplied = conversionMetadata.conversionApplied;
      expense.originalAmount = conversionMetadata.originalAmount;
      expense.originalCurrency = conversionMetadata.originalCurrency;
      expense.convertedAmount = conversionMetadata.convertedAmount;
      expense.selectedCurrency = conversionMetadata.selectedCurrency;
      expense.exchangeRateUsed = conversionMetadata.exchangeRateUsed;
      expense.exchangeRateDate = conversionMetadata.exchangeRateDate;

      // Rule 3: Always store amount in selected currency
      expense.amount = conversionMetadata.convertedAmount;
      expense.currency = selectedCurrency;
    }

    if (data.advanceAppliedAmount !== undefined) {
      const n = Number(data.advanceAppliedAmount || 0);
      if (!isFinite(n) || n < 0) {
        throw new Error('Invalid advanceAppliedAmount');
      }
      expense.advanceAppliedAmount = n;
      expense.advanceCurrency = (expense.currency || 'INR').toString().toUpperCase();
    }

    if (expense.advanceAppliedAmount && expense.advanceAppliedAmount > expense.amount) {
      throw new Error('advanceAppliedAmount cannot exceed expense amount');
    }

    if (data.expenseDate !== undefined) {
      const newExpenseDate = DateUtils.frontendDateToBackend(data.expenseDate);
      if (!DateUtils.isDateInReportRange(newExpenseDate, report.fromDate, report.toDate)) {
        throw new Error(
          `Expense date must be within report date range (${DateUtils.backendDateToFrontend(report.fromDate)} to ${DateUtils.backendDateToFrontend(report.toDate)})`
        );
      }
      expense.expenseDate = newExpenseDate;
    }

    if (data.notes !== undefined) {
      expense.notes = data.notes;
    }

    // Handle invoice fields
    if (data.invoiceId !== undefined) {
      expense.invoiceId = data.invoiceId || undefined;
    }
    if (data.invoiceDate !== undefined) {
      expense.invoiceDate = data.invoiceDate ? DateUtils.frontendDateToBackend(data.invoiceDate) : undefined;
    }
    // Keep invoiceFingerprint consistent with invoice fields (legacy indexes)
    if (expense.invoiceId && expense.invoiceDate) {
      const { DuplicateInvoiceService } = await import('./duplicateInvoice.service');
      expense.invoiceFingerprint = DuplicateInvoiceService.computeFingerprint(
        expense.invoiceId,
        expense.vendor,
        expense.invoiceDate,
        expense.amount
      );
    } else {
      expense.invoiceFingerprint = undefined;
    }
    // Duplicate detection is flag-only via DuplicateDetectionService (no throw)

    // If expense status was PENDING or REJECTED, update it back to DRAFT
    if (expense.status === ExpenseStatus.PENDING || expense.status === ExpenseStatus.REJECTED) {
      expense.status = ExpenseStatus.DRAFT;
      expense.managerComment = undefined;
      expense.managerAction = undefined;
      expense.managerActionAt = undefined;
    }

    // Manual correction of "Needs Review" expense: clear needsReview, log for training (plan §5)
    const didCorrectCategory = expense.needsReview && data.categoryId !== undefined;
    const didCorrectDate = expense.needsReview && data.expenseDate !== undefined;
    if (expense.needsReview && (didCorrectCategory || didCorrectDate)) {
      expense.needsReview = false;
      expense.ocrConfidence = undefined;
      if (didCorrectCategory) {
        await AuditService.log(userId, 'Expense', id, AuditAction.UPDATE, {
          ocrCorrection: { field: 'categoryId', prior: priorCategoryId, new: data.categoryId ?? null, source: 'manual' },
        });
      }
      if (didCorrectDate) {
        await AuditService.log(userId, 'Expense', id, AuditAction.UPDATE, {
          ocrCorrection: { field: 'expenseDate', prior: priorExpenseDate, new: data.expenseDate ?? null, source: 'manual' },
        });
      }
    }

    const saved = await expense.save();

    // Recalculate report total
    await ReportsService.recalcTotals(report._id.toString());

    // Duplicate detection: flag-only, never block
    try {
      const { DuplicateDetectionService } = await import('./duplicateDetection.service');
      const user = await User.findById(userId).select('companyId').exec();
      const companyId = user?.companyId as mongoose.Types.ObjectId | undefined;
      await DuplicateDetectionService.runDuplicateCheck(id, companyId);
    } catch (e) {
      logger.warn({ err: e, expenseId: id }, 'Duplicate check failed; continuing');
    }

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

    // Refetch to include duplicateFlag / duplicateReason
    const updated = await Expense.findById(id).exec();
    const out = (updated ?? saved).toObject();
    return {
      ...out,
      expenseDate: (updated ?? saved).expenseDate
        ? DateUtils.backendDateToFrontend((updated ?? saved).expenseDate!)
        : (out as any).expenseDate,
      invoiceDate: (updated ?? saved).invoiceDate
        ? DateUtils.backendDateToFrontend((updated ?? saved).invoiceDate!)
        : (out as any).invoiceDate,
    } as any;
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
      .populate('costCentreId', 'name code')
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

    // FORENSIC: Log raw expense from database (before transformation)
    logger.debug({
      expenseId: expense._id,
      rawExpenseFromDB: {
        hasExpenseDate: !!expense.expenseDate,
        expenseDateType: expense.expenseDate ? typeof expense.expenseDate : 'missing',
        expenseDateValue: expense.expenseDate,
        expenseDateIsDate: expense.expenseDate instanceof Date
      }
    }, 'FORENSIC (User Flow): Raw expense from database (before toObject)');
    
    // Format dates as YYYY-MM-DD strings (calendar dates, not timestamps)
    const expenseObj = expense.toObject();
    
    // FORENSIC: Log after toObject() conversion
    logger.debug({
      expenseId: expense._id,
      afterToObject: {
        hasExpenseDate: !!expenseObj.expenseDate,
        expenseDateType: expenseObj.expenseDate ? typeof expenseObj.expenseDate : 'missing',
        expenseDateValue: expenseObj.expenseDate,
        expenseDateIsDate: expenseObj.expenseDate instanceof Date
      }
    }, 'FORENSIC (User Flow): After toObject() conversion');
    
    const finalExpense = {
      ...expenseObj,
      expenseDate: expense.expenseDate ? DateUtils.backendDateToFrontend(expense.expenseDate) : expenseObj.expenseDate,
      invoiceDate: expense.invoiceDate ? DateUtils.backendDateToFrontend(expense.invoiceDate) : expenseObj.invoiceDate,
    } as any;
    
    // FORENSIC: Log final returned object
    logger.debug({
      expenseId: expense._id,
      finalReturned: {
        hasExpenseDate: !!finalExpense.expenseDate,
        expenseDateType: finalExpense.expenseDate ? typeof finalExpense.expenseDate : 'missing',
        expenseDateValue: finalExpense.expenseDate
      }
    }, 'FORENSIC (User Flow): Final returned object (after DateUtils transformation)');
    
    return finalExpense;
  }

  static async listExpensesForUser(
    userId: string,
    filters: ExpenseFiltersDto,
    req?: any // Optional AuthRequest for company-wide filtering
  ): Promise<any> {
    const { page, pageSize } = getPaginationOptions(filters.page, filters.pageSize);
    
    // Debug logging for pagination (only in non-production)
    if (config.app.env !== 'production') {
      logger.debug({ page, pageSize, skip: (page - 1) * pageSize }, '[ExpensesService] Pagination');
    }

    // Build base query
    // For company-wide duplicate detection, we need to check all expenses in the company
    // If req is provided, use company-wide filtering; otherwise, filter by specific userId
    let query: any = {};
    
    if (req) {
      // Use company-wide filtering for duplicate detection
      // This ensures we check expenses from all users in the company, not just the current user
      const { buildCompanyQuery } = await import('../utils/companyAccess');
      const companyQuery = await buildCompanyQuery(req, {}, 'users');
      
      // buildCompanyQuery returns { userId: { $in: userIds } } for company users
      // If it returns empty array, fall back to user-specific query
      if (companyQuery.userId && Array.isArray(companyQuery.userId.$in)) {
        if (companyQuery.userId.$in.length > 0) {
          // Use company-wide filtering (all users in company)
          query = companyQuery;
        } else {
          // No users in company, fall back to user-specific
          query = {
            userId: new mongoose.Types.ObjectId(userId),
          };
        }
      } else if (companyQuery._id && Array.isArray(companyQuery._id.$in) && companyQuery._id.$in.length === 0) {
        // Company query returned empty result query, fall back to user-specific
        query = {
          userId: new mongoose.Types.ObjectId(userId),
        };
      } else {
        // Use company query as-is
        query = companyQuery;
      }
    } else {
      // Default: filter by specific userId (backward compatibility)
      query = {
        userId: new mongoose.Types.ObjectId(userId),
      };
    }

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

    // Cost Centre filter
    if (filters.costCentreId) {
      query.costCentreId = filters.costCentreId;
    }

    // Date range filters
    if (filters.from || filters.to) {
      const dateRange = DateUtils.createDateRangeQuery(filters.from || filters.to!, filters.to || filters.from!);
      query.expenseDate = dateRange;
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
        .populate('costCentreId', 'name code')
        .sort({ expenseDate: -1 })
        .skip(skip)
        .limit(pageSize)
        .exec(),
      Expense.countDocuments(query).exec(),
    ]);

    // Query result logging (only in non-production)
    if (config.app.env !== 'production') {
      logger.debug({ count: expenses.length, total, requested: pageSize }, '[ExpensesService] Query result');
    }

    // Format dates as YYYY-MM-DD strings (calendar dates, not timestamps)
    const formattedExpenses = expenses.map((expense, index) => {
      // FORENSIC: Log first expense only to avoid log spam
      if (index === 0 && expenses.length > 0) {
        logger.debug({
          expenseId: expense._id,
          rawExpenseFromDB: {
            hasExpenseDate: !!expense.expenseDate,
            expenseDateType: expense.expenseDate ? typeof expense.expenseDate : 'missing',
            expenseDateValue: expense.expenseDate,
            expenseDateIsDate: expense.expenseDate instanceof Date
          }
        }, 'FORENSIC (User Flow - listExpensesForUser): Raw expense from database');
      }
      
      const expenseObj = expense.toObject();
      
      if (index === 0 && expenses.length > 0) {
        logger.debug({
          expenseId: expense._id,
          afterToObject: {
            hasExpenseDate: !!expenseObj.expenseDate,
            expenseDateType: expenseObj.expenseDate ? typeof expenseObj.expenseDate : 'missing',
            expenseDateValue: expenseObj.expenseDate,
            expenseDateIsDate: expenseObj.expenseDate instanceof Date
          }
        }, 'FORENSIC (User Flow - listExpensesForUser): After toObject() conversion');
      }
      
      const formatted = {
        ...expenseObj,
        expenseDate: expense.expenseDate ? DateUtils.backendDateToFrontend(expense.expenseDate) : expenseObj.expenseDate,
        invoiceDate: expense.invoiceDate ? DateUtils.backendDateToFrontend(expense.invoiceDate) : expenseObj.invoiceDate,
      };
      
      if (index === 0 && expenses.length > 0) {
        logger.debug({
          expenseId: expense._id,
          finalReturned: {
            hasExpenseDate: !!formatted.expenseDate,
            expenseDateType: formatted.expenseDate ? typeof formatted.expenseDate : 'missing',
            expenseDateValue: formatted.expenseDate
          }
        }, 'FORENSIC (User Flow - listExpensesForUser): Final returned object');
      }
      
      return formatted;
    });

    return createPaginatedResult(formattedExpenses, total, page, pageSize);
  }

  static async adminListExpenses(filters: ExpenseFiltersDto, req: AuthRequest): Promise<any> {
    // #region agent log
    const fs = require('fs');
    const logPath = 'd:\\APPs\\Expence Track\\.cursor\\debug.log';
    const logEntry = JSON.stringify({location:'expenses.service.ts:570',message:'adminListExpenses entry',data:{filters,userId:req.user?.id},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})+'\n';
    fs.appendFileSync(logPath, logEntry);
    // #endregion
    
    const { page, pageSize } = getPaginationOptions(filters.page, filters.pageSize);
    const baseQuery: any = {};

    if (filters.status) {
      baseQuery.status = filters.status;
    }

    if (filters.categoryId) {
      baseQuery.categoryId = filters.categoryId;
    }

    if (filters.reportId) {
      baseQuery.reportId = filters.reportId;
    }

    if (filters.from) {
      // #region agent log
      const logEntry2 = JSON.stringify({location:'expenses.service.ts:586',message:'Before date range query',data:{from:filters.from,to:filters.to},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n';
      fs.appendFileSync(logPath, logEntry2);
      // #endregion
      try {
        const dateRange = DateUtils.createDateRangeQuery(filters.from, filters.to || filters.from);
        baseQuery.expenseDate = dateRange;
        // #region agent log
        const logEntry3 = JSON.stringify({location:'expenses.service.ts:590',message:'After date range query',data:{dateRange},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n';
        fs.appendFileSync(logPath, logEntry3);
        // #endregion
      } catch (dateError: any) {
        // #region agent log
        const logEntry4 = JSON.stringify({location:'expenses.service.ts:593',message:'Date range error',data:{error:dateError.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n';
        fs.appendFileSync(logPath, logEntry4);
        // #endregion
        throw dateError;
      }
    }

    if (filters.to) {
      baseQuery.expenseDate = { ...baseQuery.expenseDate, $lte: new Date(filters.to) };
    }

    if (filters.q) {
      baseQuery.$or = [
        { vendor: { $regex: filters.q, $options: 'i' } },
        { notes: { $regex: filters.q, $options: 'i' } },
      ];
    }

    // For non-SUPER_ADMIN users, filter expenses by company
    // Expenses are linked to reports, and reports are linked to users
    // So we need to filter by reportId where report.userId is in company users
    let query = baseQuery;
    if (req.user && req.user.role !== 'SUPER_ADMIN') {
      const companyId = await getUserCompanyId(req);
      if (companyId) {
        const userIds = await getCompanyUserIds(companyId);
        if (userIds.length > 0) {
          // Get all report IDs for this company's users
          const { ExpenseReport } = await import('../models/ExpenseReport');
          const companyReports = await ExpenseReport.find({
            userId: { $in: userIds },
          })
            .select('_id')
            .exec();
          const reportIds = companyReports.map(r => r._id);
          
          if (reportIds.length > 0) {
            // If there's already a reportId filter, ensure it's in company reports
            if (baseQuery.reportId) {
              const requestedReportId = typeof baseQuery.reportId === 'string' 
                ? new mongoose.Types.ObjectId(baseQuery.reportId)
                : baseQuery.reportId;
              if (!reportIds.some((id: unknown) => (id as mongoose.Types.ObjectId).toString() === requestedReportId.toString())) {
                // Requested report doesn't belong to company, return empty result
                query = { ...baseQuery, _id: { $in: [] } };
              }
            } else {
              // Filter expenses by company report IDs
              query = {
                ...baseQuery,
                reportId: { $in: reportIds },
              };
            }
          } else {
            // No reports for this company, return empty result
            query = { ...baseQuery, _id: { $in: [] } };
          }
        } else {
          // No users in company, return empty result
          query = { ...baseQuery, _id: { $in: [] } };
        }
      } else {
        // User has no company, return empty result
        query = { ...baseQuery, _id: { $in: [] } };
      }
    }

    const skip = (page - 1) * pageSize;

    // #region agent log
    const logEntry13 = JSON.stringify({location:'expenses.service.ts:651',message:'Before Expense.find',data:{query,skip,pageSize},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'G'})+'\n';
    fs.appendFileSync(logPath, logEntry13);
    // #endregion
    
    let expenses, total;
    try {
      [expenses, total] = await Promise.all([
        Expense.find(query)
          .populate('reportId', 'name status userId projectId costCentreId')
          .populate('categoryId', 'name code')
          .populate('costCentreId', 'name code')
          .sort({ expenseDate: -1 })
          .skip(skip)
          .limit(pageSize)
          .exec(),
        Expense.countDocuments(query).exec(),
      ]);
      // #region agent log
      const logEntry14 = JSON.stringify({location:'expenses.service.ts:663',message:'After Expense.find',data:{expensesCount:expenses.length,total},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'G'})+'\n';
      fs.appendFileSync(logPath, logEntry14);
      // #endregion
    } catch (queryError: any) {
      // #region agent log
      const logEntry15 = JSON.stringify({location:'expenses.service.ts:666',message:'Expense.find error',data:{error:queryError.message,stack:queryError.stack},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'G'})+'\n';
      fs.appendFileSync(logPath, logEntry15);
      // #endregion
      throw queryError;
    }

    // Format dates as YYYY-MM-DD strings (calendar dates, not timestamps)
    const formattedExpenses = expenses.map((expense) => {
      const expenseObj = expense.toObject();
      return {
        ...expenseObj,
        expenseDate: expense.expenseDate ? DateUtils.backendDateToFrontend(expense.expenseDate) : expenseObj.expenseDate,
        invoiceDate: expense.invoiceDate ? DateUtils.backendDateToFrontend(expense.invoiceDate) : expenseObj.invoiceDate,
      };
    });

    return createPaginatedResult(formattedExpenses, total, page, pageSize);
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

    // Format dates as YYYY-MM-DD strings (calendar dates, not timestamps)
    const savedObj = saved.toObject();
    return {
      ...savedObj,
      expenseDate: saved.expenseDate ? DateUtils.backendDateToFrontend(saved.expenseDate) : savedObj.expenseDate,
      invoiceDate: saved.invoiceDate ? DateUtils.backendDateToFrontend(saved.invoiceDate) : savedObj.invoiceDate,
    } as any;
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

    // Check if report exists
    if (!report) {
      throw new Error('Expense report not found');
    }

    // Check if report has required fields
    if (!report._id || !report.userId) {
      throw new Error('Invalid expense report data');
    }

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

    // Recalculate report total (handle potential errors)
    try {
      await ReportsService.recalcTotals(reportId);
    } catch (recalcError: any) {
      console.error('Error recalculating report totals after expense deletion:', recalcError);
      // Don't throw - expense is already deleted, recalc can be retried
    }

    try {
      await AuditService.log(userId, 'Expense', id, AuditAction.DELETE);
    } catch (auditError: any) {
      console.error('Error logging audit trail:', auditError);
      // Don't throw - expense deletion succeeded, audit is secondary
    }
  }

  /**
   * Get company's selected currency (Rule 2: Selected Account / Company Currency)
   * @param userId - User ID to get company from
   * @returns Company's selected currency (default: 'INR')
   */
  private static async getCompanySelectedCurrency(userId: string): Promise<string> {
    try {
      const user = await User.findById(userId).select('companyId').exec();
      if (!user || !user.companyId) {
        return 'INR'; // Default currency
      }

      const companyId = user.companyId.toString();
      const settings = await CompanySettingsService.getSettingsByCompanyId(companyId);
      return settings.general?.currency || 'INR';
    } catch (error) {
      logger.error({ error, userId }, 'Error getting company selected currency');
      return 'INR'; // Default fallback
    }
  }

  /**
   * Process currency conversion (Rule 3 & 4: Currency Comparison & Conversion Logic)
   * @param originalAmount - Original amount in original currency
   * @param originalCurrency - Original currency detected
   * @param selectedCurrency - Company's selected currency
   * @returns Conversion metadata
   */
  private static async processCurrencyConversion(
    originalAmount: number,
    originalCurrency: string,
    selectedCurrency: string
  ): Promise<{
    conversionApplied: boolean;
    originalAmount: number;
    originalCurrency: string;
    convertedAmount: number;
    selectedCurrency: string;
    exchangeRateUsed: number;
    exchangeRateDate: Date;
  }> {
    const original = originalCurrency.toUpperCase();
    const selected = selectedCurrency.toUpperCase();

    // Rule 3: If currencies match, no conversion needed
    if (original === selected) {
      return {
        conversionApplied: false,
        originalAmount,
        originalCurrency: original,
        convertedAmount: originalAmount,
        selectedCurrency: selected,
        exchangeRateUsed: 1,
        exchangeRateDate: new Date(),
      };
    }

    // Rule 4: Conversion is mandatory
    try {
      logger.info({
        originalAmount,
        originalCurrency: original,
        selectedCurrency: selected,
      }, 'Processing currency conversion');

      const conversion = await currencyService.convertCurrency(
        originalAmount,
        original,
        selected
      );

      logger.info({
        originalAmount,
        originalCurrency: original,
        convertedAmount: conversion.convertedAmount,
        selectedCurrency: selected,
        rate: conversion.rate,
      }, 'Currency conversion completed');

      return {
        conversionApplied: true,
        originalAmount,
        originalCurrency: original,
        convertedAmount: conversion.convertedAmount,
        selectedCurrency: selected,
        exchangeRateUsed: conversion.rate,
        exchangeRateDate: conversion.rateDate,
      };
    } catch (error: any) {
      logger.error({
        error: error.message,
        stack: error.stack,
        originalAmount,
        originalCurrency,
        selectedCurrency,
      }, 'Error processing currency conversion');
      
      // Don't fail silently - throw the error so caller can handle it
      throw new Error(`Currency conversion failed: ${error.message}`);
    }
  }
}


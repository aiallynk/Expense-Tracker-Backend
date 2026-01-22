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

    // Rule 1: Detect original currency (from OCR, manual input, or existing expense)
    const originalCurrency = (data.currency || 'INR').toUpperCase();
    const originalAmount = data.amount;

    // Check for duplicate invoice if invoice fields are provided
    // Use original amount for duplicate detection (not converted amount)
    if (data.invoiceId && invoiceDate) {
      const { DuplicateInvoiceService } = await import('./duplicateInvoice.service');
      const user = await User.findById(userId).select('companyId').exec();
      invoiceFingerprint = DuplicateInvoiceService.computeFingerprint(
        data.invoiceId,
        data.vendor,
        invoiceDate,
        originalAmount // Use original amount for duplicate detection
      );
      
      if (user && user.companyId) {
        const duplicateCheck = await DuplicateInvoiceService.checkDuplicate(
          data.invoiceId,
          data.vendor,
          invoiceDate,
          originalAmount, // Use original amount for duplicate detection
          undefined, // No excludeExpenseId for new expenses
          user.companyId
        );

        if (duplicateCheck.isDuplicate) {
          throw new Error(duplicateCheck.message || 'Duplicate invoice detected');
        }
      }
    }

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
      expenseDate: DateUtils.frontendDateToBackend(data.expenseDate),
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

    // Format dates as YYYY-MM-DD strings (calendar dates, not timestamps)
    const savedObj = saved.toObject();
    return {
      ...savedObj,
      expenseDate: saved.expenseDate ? DateUtils.backendDateToFrontend(saved.expenseDate) : savedObj.expenseDate,
      invoiceDate: saved.invoiceDate ? DateUtils.backendDateToFrontend(saved.invoiceDate) : savedObj.invoiceDate,
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
      expense.expenseDate = DateUtils.frontendDateToBackend(data.expenseDate);
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
    // Keep invoiceFingerprint consistent with invoice fields
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

    // Check for duplicate invoice if invoice fields are being updated
    if ((data.invoiceId !== undefined || data.invoiceDate !== undefined) && 
        expense.invoiceId && expense.invoiceDate) {
      const { DuplicateInvoiceService } = await import('./duplicateInvoice.service');
      const user = await User.findById(userId).select('companyId').exec();
      
      if (user && user.companyId) {
        const expenseId = (expense._id as mongoose.Types.ObjectId).toString();
        const duplicateCheck = await DuplicateInvoiceService.checkDuplicate(
          expense.invoiceId,
          expense.vendor,
          expense.invoiceDate,
          expense.amount,
          expenseId, // Exclude current expense
          user.companyId
        );

        if (duplicateCheck.isDuplicate) {
          throw new Error(duplicateCheck.message || 'Duplicate invoice detected');
        }
      }
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

    // Format dates as YYYY-MM-DD strings (calendar dates, not timestamps)
    const savedObj = saved.toObject();
    return {
      ...savedObj,
      expenseDate: saved.expenseDate ? DateUtils.backendDateToFrontend(saved.expenseDate) : savedObj.expenseDate,
      invoiceDate: saved.invoiceDate ? DateUtils.backendDateToFrontend(saved.invoiceDate) : savedObj.invoiceDate,
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

    // Format dates as YYYY-MM-DD strings (calendar dates, not timestamps)
    const expenseObj = expense.toObject();
    return {
      ...expenseObj,
      expenseDate: expense.expenseDate ? DateUtils.backendDateToFrontend(expense.expenseDate) : expenseObj.expenseDate,
      invoiceDate: expense.invoiceDate ? DateUtils.backendDateToFrontend(expense.invoiceDate) : expenseObj.invoiceDate,
    } as any;
  }

  static async listExpensesForUser(
    userId: string,
    filters: ExpenseFiltersDto
  ): Promise<any> {
    const { page, pageSize } = getPaginationOptions(filters.page, filters.pageSize);
    
    // Debug logging for pagination
    console.log(`[ExpensesService] Pagination: page=${page}, pageSize=${pageSize}, skip=${(page - 1) * pageSize}`);

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

    console.log(`[ExpensesService] Query result: ${expenses.length} expenses returned (total: ${total}, requested: ${pageSize})`);

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

  static async adminListExpenses(filters: ExpenseFiltersDto, req: AuthRequest): Promise<any> {
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
      const dateRange = DateUtils.createDateRangeQuery(filters.from, filters.to || filters.from);
      baseQuery.expenseDate = dateRange;
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

    const [expenses, total] = await Promise.all([
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


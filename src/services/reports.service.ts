import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { ApprovalRule, ApprovalRuleTriggerType, ApprovalRuleApproverRole } from '../models/ApprovalRule';
import { ApproverMapping, IApproverMapping } from '../models/ApproverMapping';
import { CompanySettings, ICompanySettings } from '../models/CompanySettings';
import { CostCentre } from '../models/CostCentre';
import { Expense } from '../models/Expense';
import {
  ExpenseReport,
  IExpenseReport,
  IApprover,
} from '../models/ExpenseReport';
import { Project } from '../models/Project';
import { User } from '../models/User';
import { emitManagerReportUpdate, emitManagerDashboardUpdate } from '../socket/realtimeEvents';
import { buildCompanyQuery } from '../utils/companyAccess';
import { CreateReportDto, UpdateReportDto, ReportFiltersDto } from '../utils/dtoTypes';
import { ExpenseReportStatus, UserRole, ExpenseStatus, AuditAction } from '../utils/enums';
import { getPaginationOptions, createPaginatedResult } from '../utils/pagination';

import { ApprovalService } from './ApprovalService';
import { AuditService } from './audit.service';
import { BusinessHeadSelectionService } from './businessHeadSelection.service';
import { enqueueAnalyticsEvent } from './companyAnalyticsSnapshot.service';
import { EmployeeApprovalProfileService } from './EmployeeApprovalProfileService';
import { NotificationService } from './notification.service';
import { ApprovalType, ParallelRule } from '../models/ApprovalMatrix';

import { logger } from '@/config/logger';
import { config } from '@/config/index';
import { DateUtils } from '@/utils/dateUtils';

export class ReportsService {
  private static buildDefaultReportName(fromDate: Date, employeeName: string): string {
    const month = fromDate.toLocaleString('en-US', { month: 'long' });
    const safeEmployee = employeeName?.trim() || 'Employee';
    return `Expense Report – ${month} – ${safeEmployee}`;
  }

  static async createReport(
    userId: string,
    data: CreateReportDto
  ): Promise<IExpenseReport> {
    logger.info('ReportsService.createReport - Starting report creation');
    logger.debug({ userId }, 'User ID');
    logger.debug({
      name: data.name,
      projectId: data.projectId || 'none',
      fromDate: data.fromDate,
      toDate: data.toDate,
      notes: data.notes || 'none',
    }, 'Report data');

    try {
      // Validate projectId - if provided, it must be a valid ObjectId
      // If it's not a valid ObjectId (e.g., user typed a name), ignore it
      let projectId: mongoose.Types.ObjectId | undefined = undefined;
      if (data.projectId && data.projectId.trim() !== '') {
        if (mongoose.Types.ObjectId.isValid(data.projectId)) {
          projectId = new mongoose.Types.ObjectId(data.projectId);
          logger.debug({ projectId }, 'Valid projectId provided');
        } else {
          logger.warn({ projectId: data.projectId }, 'Invalid projectId provided (not a valid ObjectId), ignoring');
          // Don't throw error, just ignore invalid projectId
        }
      }

      // Validate costCentreId - if provided, it must be a valid ObjectId
      let costCentreId: mongoose.Types.ObjectId | undefined = undefined;
      if (data.costCentreId && data.costCentreId.trim() !== '') {
        if (mongoose.Types.ObjectId.isValid(data.costCentreId)) {
          costCentreId = new mongoose.Types.ObjectId(data.costCentreId);
          logger.debug({ costCentreId }, 'Valid costCentreId provided');
        } else {
          logger.warn({ costCentreId: data.costCentreId }, 'Invalid costCentreId provided (not a valid ObjectId), ignoring');
        }
      }

      const fromDate = DateUtils.frontendDateToBackend(data.fromDate);
      const toDate = DateUtils.frontendDateToBackend(data.toDate);
      const requestedName = (data.name || '').trim();
      let finalName = requestedName;

      if (!finalName) {
        const user = await User.findById(userId).select('name email').exec();
        const employeeName = (user?.name || user?.email || 'Employee').toString();
        finalName = this.buildDefaultReportName(fromDate, employeeName);
      }

      // Handle advance cash (report-level)
      let advanceAppliedAmount: number | undefined = undefined;
      let advanceCurrency: string | undefined = undefined;

      if (data.advanceAppliedAmount !== undefined && data.advanceAppliedAmount > 0) {
        advanceAppliedAmount = Number(data.advanceAppliedAmount);
        if (!isFinite(advanceAppliedAmount) || advanceAppliedAmount < 0) {
          throw new Error('Invalid advanceAppliedAmount');
        }
        advanceCurrency = data.advanceCurrency?.toUpperCase() || 'INR';
      }

      const report = new ExpenseReport({
        userId,
        projectId,
        projectName: data.projectName?.trim() || undefined,
        costCentreId,
        name: finalName,
        notes: data.notes,
        fromDate,
        toDate,
        status: ExpenseReportStatus.DRAFT,
        advanceAppliedAmount,
        advanceCurrency,
      });

      logger.info('ExpenseReport model instance created');
      logger.debug({
        userId: report.userId,
        name: report.name,
        fromDate: report.fromDate,
        toDate: report.toDate,
        status: report.status,
      }, 'Report instance');

      logger.info('Saving report to database (expensereports collection)...');
      const saved = await report.save();
      logger.info('Report saved successfully to expensereports collection');
      logger.info({ reportId: saved._id }, 'Saved report ID');
      logger.info({
        _id: saved._id,
        name: saved.name,
        status: saved.status,
        userId: saved.userId,
        fromDate: saved.fromDate,
        toDate: saved.toDate,
        createdAt: saved.createdAt,
      }, 'Saved report details');

      logger.info('Creating audit log...');
      await AuditService.log(
        userId,
        'ExpenseReport',
        (saved._id as mongoose.Types.ObjectId).toString(),
        AuditAction.CREATE
      );
      logger.info('Audit log created successfully');

      // Enqueue analytics update (background worker will refresh snapshot)
      try {
        const user = await User.findById(userId).select('companyId').exec();
        if (user && user.companyId) {
          enqueueAnalyticsEvent({ companyId: user.companyId.toString(), event: 'REBUILD_SNAPSHOT' });
        }
      } catch (error) {
        logger.error({ error }, 'Error enqueueing analytics update');
      }

      logger.info('ReportsService.createReport - Report creation completed successfully');
      return saved;
    } catch (error: any) {
      logger.error({ error }, 'ReportsService.createReport - Error creating report');
      logger.error({
        message: error.message,
        stack: error.stack,
        name: error.name,
      }, 'Error details');
      throw error;
    }
  }

  static async getReportsForUser(
    userId: string,
    filters: ReportFiltersDto
  ): Promise<any> {
    const { page, pageSize } = getPaginationOptions(filters.page, filters.pageSize);

    // Debug logging for pagination (only in non-production)
    if (config.app.env !== 'production') {
      logger.debug({ page, pageSize, skip: (page - 1) * pageSize }, '[ReportsService] Pagination');
    }

    // Ensure userId is converted to ObjectId for proper matching
    const query: any = { userId: new mongoose.Types.ObjectId(userId) };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.projectId) {
      query.projectId = filters.projectId;
    }

    if (filters.from || filters.to) {
      const dateRange = DateUtils.createDateRangeQuery(filters.from || filters.to!, filters.to || filters.from!);

      if (filters.from) {
        query.fromDate = { $gte: dateRange.$gte };
      }

      if (filters.to) {
        query.toDate = { $lte: dateRange.$lte };
      }
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

    // Query result logging (only in non-production)
    if (config.app.env !== 'production') {
      logger.debug({ count: reports.length, total, requested: pageSize }, '[ReportsService] Query result');
    }

    // Get expenses count for each report
    // Format dates as strings to prevent timezone conversion issues
    let reportsWithExpenses: any[] = reports.map((r) => {
      const reportObj = r.toObject();
      return {
        ...reportObj,
        // Format dates as YYYY-MM-DD strings (calendar dates, not timestamps)
        fromDate: r.fromDate ? DateUtils.backendDateToFrontend(r.fromDate) : reportObj.fromDate,
        toDate: r.toDate ? DateUtils.backendDateToFrontend(r.toDate) : reportObj.toDate,
      };
    });

    if (reports.length > 0) {
      const reportIds = reports.map((r) => r._id as mongoose.Types.ObjectId);
      const [expensesCounts, flagsAgg] = await Promise.all([
        Expense.aggregate([
          { $match: { reportId: { $in: reportIds } } },
          { $group: { _id: '$reportId', count: { $sum: 1 } } },
        ]),
        // §2 §3: Aggregate expense-level flags per report (duplicate_flagged, ocr_needs_review)
        Expense.aggregate([
          { $match: { reportId: { $in: reportIds } } },
          {
            $group: {
              _id: '$reportId',
              duplicate_flagged: { $max: { $cond: [{ $in: ['$duplicateFlag', ['POTENTIAL_DUPLICATE', 'STRONG_DUPLICATE']] }, 1, 0] } },
              ocr_needs_review: { $max: { $cond: ['$needsReview', 1, 0] } },
            },
          },
        ]),
      ]);

      const expensesCountMap = new Map<string, number>();
      expensesCounts.forEach((item) => {
        const reportId = item._id instanceof mongoose.Types.ObjectId
          ? item._id.toString()
          : String(item._id);
        expensesCountMap.set(reportId, item.count);
      });

      const flagsMap = new Map<string, { duplicate_flagged: boolean; ocr_needs_review: boolean }>();
      flagsAgg.forEach((item) => {
        const reportId = item._id instanceof mongoose.Types.ObjectId
          ? item._id.toString()
          : String(item._id);
        flagsMap.set(reportId, {
          duplicate_flagged: !!item.duplicate_flagged,
          ocr_needs_review: !!item.ocr_needs_review,
        });
      });

      // Add expenses count, flags (§2 §3), and format dates
      reportsWithExpenses = reports.map((report) => {
        const reportObj = report.toObject();
        const reportId = (report._id as mongoose.Types.ObjectId).toString();
        const expensesCount = expensesCountMap.get(reportId) || 0;
        const expenseFlags = flagsMap.get(reportId) || { duplicate_flagged: false, ocr_needs_review: false };
        const status = (report.status || '').toUpperCase();
        const approvers = (report as any).approvers || reportObj.approvers || [];
        const appliedVouchers = (report as any).appliedVouchers || reportObj.appliedVouchers || [];
        const flags = {
          changes_requested: status === 'CHANGES_REQUESTED',
          rejected: status === 'REJECTED',
          duplicate_flagged: expenseFlags.duplicate_flagged,
          voucher_applied: Array.isArray(appliedVouchers) && appliedVouchers.length > 0,
          additional_approver_added: Array.isArray(approvers) && approvers.some((a: any) => a.isAdditionalApproval === true),
          ocr_needs_review: expenseFlags.ocr_needs_review,
        };
        return {
          ...reportObj,
          fromDate: report.fromDate ? DateUtils.backendDateToFrontend(report.fromDate) : reportObj.fromDate,
          toDate: report.toDate ? DateUtils.backendDateToFrontend(report.toDate) : reportObj.toDate,
          expensesCount,
          expenses: [],
          flags,
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
      .populate({
        path: 'userId',
        select: 'name email companyId departmentId managerId',
        populate: [
          { path: 'departmentId', select: 'name' },
          { path: 'managerId', select: 'name email' },
        ],
      })
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

    logger.debug({
      reportId: id,
      reportUserId,
      requestingUserId: requestingUserIdStr,
      requestingUserRole,
      userIdType: typeof userIdValue,
      userIdIsObject: typeof userIdValue === 'object',
    }, 'Checking report access');

    // Check access: owner, admin, business head, or company admin (if report user is in their company)
    let hasAccess = false;

    if (reportUserId === requestingUserIdStr) {
      // Owner has access
      hasAccess = true;
    } else if (requestingUserRole === 'SUPER_ADMIN') {
      // SUPER_ADMIN has unrestricted access
      hasAccess = true;
    } else {
      // For all other roles (ADMIN, BUSINESS_HEAD, COMPANY_ADMIN, etc.), check company access
      try {
        const { User } = await import('../models/User');

        // Get report user's company ID
        const reportUser = await User.findById(reportUserId).select('companyId').exec();
        if (!reportUser || !reportUser.companyId) {
          hasAccess = false;
        } else {
          const reportCompanyId = reportUser.companyId.toString();

          // For COMPANY_ADMIN, check their company
          if (requestingUserRole === 'COMPANY_ADMIN') {
            const { CompanyAdmin } = await import('../models/CompanyAdmin');
            const companyAdmin = await CompanyAdmin.findById(requestingUserIdStr).select('companyId').exec();
            if (companyAdmin && companyAdmin.companyId) {
              hasAccess = companyAdmin.companyId.toString() === reportCompanyId;
            }
          } else {
            // For ADMIN, BUSINESS_HEAD, MANAGER, etc., check their company matches report company
            const requestingUser = await User.findById(requestingUserIdStr).select('companyId').exec();
            if (requestingUser && requestingUser.companyId) {
              hasAccess = requestingUser.companyId.toString() === reportCompanyId;
            }
          }
        }
      } catch (error) {
        logger.error({ error }, 'Error checking company access for report');
        // If there's an error, deny access
        hasAccess = false;
      }
    }

    if (!hasAccess) {
      logger.warn({
        reportId: id,
        reportUserId,
        requestingUserId: requestingUserIdStr,
        requestingUserRole,
      }, 'Access denied to report');
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

    // Generate signed URLs for receipts (S3 buckets are private)
    const { getPresignedDownloadUrl } = await import('../utils/s3');
    const expensesWithSignedUrls = await Promise.all(
      expenses.map(async (expense: any) => {
        const expenseObj = expense.toObject();
        // Format dates as YYYY-MM-DD strings (calendar dates, not timestamps)
        const formattedExpense = {
          ...expenseObj,
          expenseDate: expense.expenseDate ? DateUtils.backendDateToFrontend(expense.expenseDate) : expenseObj.expenseDate,
          invoiceDate: expense.invoiceDate ? DateUtils.backendDateToFrontend(expense.invoiceDate) : expenseObj.invoiceDate,
        };
        if (formattedExpense.receiptPrimaryId && formattedExpense.receiptPrimaryId.storageKey) {
          try {
            const signedUrl = await getPresignedDownloadUrl(
              'receipts',
              expenseObj.receiptPrimaryId.storageKey,
              7 * 24 * 60 * 60 // 7 days
            );
            expenseObj.receiptPrimaryId.signedUrl = signedUrl;
          } catch (error) {
            logger.error({
              expenseId: expenseObj._id,
              storageKey: expenseObj.receiptPrimaryId.storageKey,
              error: error instanceof Error ? error.message : String(error),
            }, 'Failed to generate signed URL for receipt');
            // Continue without signed URL - frontend will handle gracefully
          }
        }
        return formattedExpense;
      })
    );

    // Fetch approval instance to get approval chain details
    let approvalChain = [];
    try {
      const { ApprovalInstance } = await import('../models/ApprovalInstance');
      const { Role } = await import('../models/Role');
      const { User } = await import('../models/User');

      const approvalInstance = await ApprovalInstance.findOne({
        requestId: id,
        requestType: 'EXPENSE_REPORT'
      })
        .populate('matrixId')
        .exec();

      if (approvalInstance) {
        const matrix = approvalInstance.matrixId as any;

        // Build approval chain from history and matrix levels
        if (matrix && matrix.levels) {
          const sortedLevels = [...matrix.levels].sort((a: any, b: any) => a.levelNumber - b.levelNumber);

          for (const level of sortedLevels) {
            if (!level.enabled) continue;

            // Get history entries for this level
            const levelHistory = (approvalInstance.history || []).filter(
              (h: any) => h.levelNumber === level.levelNumber
            );

            // Get role names for this level
            const roleIds = level.approverRoleIds || [];
            let roleNames: string[] = [];

            // Fetch actual role names from Role model - this is the source of truth
            if (roleIds.length > 0) {
              const roles = await Role.find({ _id: { $in: roleIds } }).select('name').exec();
              roleNames = roles.map(r => r.name).filter(Boolean); // Filter out any null/undefined names
            }

            // Get approver details from history
            const approverHistory = levelHistory.find((h: any) => h.approverId);
            let approverName = null;
            let approverId = null;
            let decidedAt = null;
            let comment = null;
            let action = null;

            if (approverHistory) {
              const approver = await User.findById(approverHistory.approverId).select('name').exec();
              approverName = approver?.name || null;
              approverId = approverHistory.approverId;
              decidedAt = approverHistory.timestamp;
              comment = approverHistory.comments;
              action = approverHistory.status?.toLowerCase();
            }

            // ALWAYS use actual role names from approval matrix - never use generic fallback names
            // The role field should contain the actual role names from the Role model
            const roleNameDisplay = roleNames.length > 0 ? roleNames.join(', ') : '';
            let stepName;

            // Prioritize actual role names from approval matrix
            if (roleNames.length > 0) {
              // Use the actual role name(s) from the approval matrix (e.g., "Finance Manager", "CTO", etc.)
              stepName = roleNameDisplay;
            } else {
              // Only use generic level-based naming if NO roles are configured in the approval matrix
              // This should rarely happen if approval matrix is properly configured
              stepName = `Level ${level.levelNumber} Approval`;
            }

            // Map action to frontend expected format
            let mappedAction = null;
            if (action === 'approved') mappedAction = 'approve';
            else if (action === 'rejected') mappedAction = 'reject';
            else if (action === 'changes_requested') mappedAction = 'request_changes';

            // Check if this approver is an additional approver from the report's approvers array
            const reportApprover = (report.approvers || []).find(
              (a: any) => a.level === level.levelNumber && a.isAdditionalApproval === true
            );

            approvalChain.push({
              level: level.levelNumber,
              step: stepName,
              role: roleNameDisplay, // Actual role names from Role model
              roleIds: roleIds,
              name: approverName, // Frontend expects 'name'
              approverName: approverName, // Also include for compatibility
              approverId: approverId,
              userId: approverId ? { name: approverName } : null, // Frontend may check userId.name
              decidedAt: decidedAt,
              comment: comment, // Frontend expects 'comment'
              action: mappedAction, // Frontend expects 'approve', 'reject', 'request_changes'
              isAdditionalApproval: reportApprover ? true : false,
              triggerReason: reportApprover?.triggerReason || null,
              approvalRuleId: reportApprover?.approvalRuleId || null
            });
          }

          // Append additional approvers from report.approvers that are not in matrix levels
          const chainLevels = new Set(approvalChain.map((a: any) => a.level));
          const additionalFromReport = (report.approvers || []).filter(
            (a: any) => a.isAdditionalApproval === true && !chainLevels.has(a.level)
          );
          for (const addApprover of additionalFromReport) {
            const addUserId = addApprover.userId?.toString?.() || addApprover.userId;
            let addName: string | null = null;
            if (addUserId) {
              const addUser = await User.findById(addUserId).select('name').exec();
              addName = addUser?.name || null;
            }
            const addRole = addApprover.role || 'Additional Approver';
            const addStep = addApprover.triggerReason ? `Additional: ${addApprover.triggerReason}` : `Additional Approval (${addRole})`;
            const addHistory = (approvalInstance.history || []).filter(
              (h: any) => h.levelNumber === addApprover.level
            );
            const addEntry = addHistory.find((h: any) => h.approverId);
            let addAction: string | null = null;
            let addDecidedAt = addApprover.decidedAt || null;
            let addComment = addApprover.comment || null;
            if (addEntry) {
              addAction = addEntry.status?.toLowerCase() === 'approved' ? 'approve' : addEntry.status?.toLowerCase() === 'rejected' ? 'reject' : addEntry.status?.toLowerCase() === 'changes_requested' ? 'request_changes' : null;
              addDecidedAt = addEntry.timestamp || addDecidedAt;
              addComment = addEntry.comments || addComment;
            }
            approvalChain.push({
              level: addApprover.level,
              step: addStep,
              role: addRole,
              roleIds: [],
              name: addName,
              approverName: addName,
              approverId: addUserId,
              userId: addName ? { name: addName } : null,
              decidedAt: addDecidedAt,
              comment: addComment,
              action: addAction,
              isAdditionalApproval: true,
              triggerReason: addApprover.triggerReason || null,
              approvalRuleId: addApprover.approvalRuleId || null
            });
          }

          // When report is REJECTED, mark all steps after the first rejected step as skipped so UI does not show them as pending
          const reportStatus = (report.status || '').toUpperCase();
          if (reportStatus === 'REJECTED') {
            const rejectedIndex = approvalChain.findIndex((a: any) => a.action === 'reject');
            if (rejectedIndex >= 0) {
              for (let i = rejectedIndex + 1; i < approvalChain.length; i++) {
                (approvalChain[i] as any).action = 'skipped';
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error({ error, reportId: id }, 'Error fetching approval chain');
      // Continue without approval chain if there's an error
    }

    // Voucher breakdown (plan §2.5): appliedVouchers, voucherTotalUsed, employeePaidAmount
    const appliedVouchers = (report as any).appliedVouchers || [];
    const voucherTotalUsed = appliedVouchers.length > 0
      ? appliedVouchers.reduce((s: number, a: any) => s + (a.amountUsed || 0), 0)
      : (report.advanceAppliedAmount ?? 0);
    const employeePaidAmount = Math.max(0, (report.totalAmount ?? 0) - voucherTotalUsed);

    const reportObj = report.toObject();
    const approversFinal = approvalChain.length > 0 ? approvalChain : reportObj.approvers || [];
    const status = (report.status || '').toUpperCase();
    const flags = {
      changes_requested: status === 'CHANGES_REQUESTED',
      rejected: status === 'REJECTED',
      duplicate_flagged: expensesWithSignedUrls.some(
        (e: any) => e.duplicateFlag === 'POTENTIAL_DUPLICATE' || e.duplicateFlag === 'STRONG_DUPLICATE'
      ),
      voucher_applied: appliedVouchers.length > 0,
      additional_approver_added: Array.isArray(approversFinal) && approversFinal.some((a: any) => a.isAdditionalApproval === true),
      ocr_needs_review: expensesWithSignedUrls.some((e: any) => e.needsReview === true),
    };

    // §4: When CHANGES_REQUESTED, include affectedExpenseIds for highlighting on report detail
    const affectedExpenseIds: string[] =
      status === 'CHANGES_REQUESTED'
        ? expensesWithSignedUrls
          .filter(
            (e: any) =>
              (e.managerAction && String(e.managerAction).toLowerCase() === 'request_changes') ||
              (e.managerComment && String(e.managerComment).trim().length > 0)
          )
          .map((e: any) => (e._id != null ? String(e._id) : ''))
          .filter(Boolean)
        : [];

    return {
      ...reportObj,
      fromDate: report.fromDate ? DateUtils.backendDateToFrontend(report.fromDate) : reportObj.fromDate,
      toDate: report.toDate ? DateUtils.backendDateToFrontend(report.toDate) : reportObj.toDate,
      expenses: expensesWithSignedUrls,
      approvers: approversFinal,
      appliedVouchers: appliedVouchers.length > 0 ? appliedVouchers : reportObj.appliedVouchers,
      voucherTotalUsed,
      employeePaidAmount,
      flags,
      ...(affectedExpenseIds.length > 0 ? { affectedExpenseIds } : {}),
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

    if (data.projectName !== undefined) {
      report.projectName = data.projectName.trim() || undefined;
    }

    if (data.costCentreId !== undefined) {
      if (data.costCentreId === null || data.costCentreId === '') {
        report.costCentreId = undefined;
      } else if (mongoose.Types.ObjectId.isValid(data.costCentreId)) {
        report.costCentreId = new mongoose.Types.ObjectId(data.costCentreId);
      }
    }

    if (data.fromDate !== undefined) {
      // Use DateUtils to parse date string correctly (handles IST timezone)
      report.fromDate = DateUtils.frontendDateToBackend(data.fromDate);
    }

    if (data.toDate !== undefined) {
      // Use DateUtils to parse date string correctly (handles IST timezone)
      report.toDate = DateUtils.frontendDateToBackend(data.toDate);
    }

    // Handle advance cash (report-level)
    if (data.advanceAppliedAmount !== undefined) {
      const advanceAmount = Number(data.advanceAppliedAmount);
      if (!isFinite(advanceAmount) || advanceAmount < 0) {
        throw new Error('Invalid advanceAppliedAmount');
      }
      // Validate advance doesn't exceed report total (if report has expenses)
      if (advanceAmount > 0 && report.totalAmount > 0 && advanceAmount > report.totalAmount) {
        throw new Error('Advance amount cannot exceed report total amount');
      }
      report.advanceAppliedAmount = advanceAmount > 0 ? advanceAmount : undefined;
      report.advanceCurrency = advanceAmount > 0
        ? (data.advanceCurrency?.toUpperCase() || report.currency || 'INR')
        : undefined;
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

  /**
   * Build effective matrix levels from an employee's personalized approval profile.
   * Used when the report submitter has an active EmployeeApprovalProfile (personalized matrix).
   */
  private static buildEffectiveLevelsFromProfile(approverChain: Array<{ level: number; mode: string; approvalType?: string | null; roles: string[]; approverUserIds?: string[] }>): Array<{
    levelNumber: number;
    enabled: boolean;
    approvalType: string;
    parallelRule?: string;
    approverRoleIds: mongoose.Types.ObjectId[];
    approverUserIds: mongoose.Types.ObjectId[];
    conditions: any[];
    skipAllowed: boolean;
  }> {
    return approverChain.map((lvl) => {
      const approvalType = (lvl.mode === 'PARALLEL' ? ApprovalType.PARALLEL : ApprovalType.SEQUENTIAL) as string;
      const parallelRule = lvl.mode === 'PARALLEL' && (lvl.approvalType === 'ANY' || lvl.approvalType === 'ALL')
        ? (lvl.approvalType === 'ANY' ? ParallelRule.ANY : ParallelRule.ALL)
        : undefined;
      const approverRoleIds = (lvl.roles || [])
        .filter((r) => r && mongoose.Types.ObjectId.isValid(r))
        .map((r) => new mongoose.Types.ObjectId(r));
      const approverUserIds = (lvl.approverUserIds || [])
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      return {
        levelNumber: lvl.level,
        enabled: true,
        approvalType,
        parallelRule,
        approverRoleIds,
        approverUserIds,
        conditions: [],
        skipAllowed: false,
      };
    });
  }

  static async computeApproverChain(report: IExpenseReport): Promise<IApprover[]> {
    const approvers: IApprover[] = [];
    const reportUser = await User.findById(report.userId);

    if (!reportUser) {
      throw new Error('Report owner not found');
    }

    // Get company settings to determine approval levels
    let companySettings: ICompanySettings | null = null;
    let approvalLevels = 2; // Default to 2 levels (L1 and L2 are always required)
    let approvalMatrix: ICompanySettings['approvalMatrix'] | null = null;
    if (reportUser.companyId) {
      companySettings = await CompanySettings.findOne({ companyId: reportUser.companyId }).exec();
      if (companySettings) {
        // Use approvalMatrix if available, otherwise fallback to legacy approvalFlow
        if (companySettings.approvalMatrix) {
          approvalMatrix = companySettings.approvalMatrix;
          // Count enabled optional levels (L3, L4, L5)
          let enabledOptionalLevels = 0;
          if (approvalMatrix.level3?.enabled) enabledOptionalLevels++;
          if (approvalMatrix.level4?.enabled) enabledOptionalLevels++;
          if (approvalMatrix.level5?.enabled) enabledOptionalLevels++;
          approvalLevels = 2 + enabledOptionalLevels; // L1 + L2 + optional levels
        } else {
          // Legacy: use approvalFlow.multiLevelApproval
          approvalLevels = companySettings.approvalFlow.multiLevelApproval || 2;
        }
      }
    }

    // STEP 1: Check for custom approver mapping first
    let customMapping: IApproverMapping | null = null;
    if (reportUser.companyId) {
      customMapping = await ApproverMapping.findOne({
        userId: reportUser._id,
        companyId: reportUser.companyId,
        isActive: true,
      }).exec();
    }

    if (customMapping) {
      // Use custom mapping
      const mappingLevels = [
        { level: 1, approverId: customMapping.level1ApproverId },
        { level: 2, approverId: customMapping.level2ApproverId },
        { level: 3, approverId: customMapping.level3ApproverId },
        { level: 4, approverId: customMapping.level4ApproverId },
        { level: 5, approverId: customMapping.level5ApproverId },
      ];

      for (const mapping of mappingLevels) {
        if (mapping.level <= approvalLevels && mapping.approverId) {
          const approver = await User.findById(mapping.approverId).exec();
          if (approver && approver.status === 'ACTIVE') {
            approvers.push({
              level: mapping.level,
              userId: approver._id as mongoose.Types.ObjectId,
              role: approver.role,
            });
          }
        }
      }
    } else {
      // STEP 2: Build hierarchy-based approval chain (fallback)
      // Level 1: Manager (if employee has a manager)
      if (reportUser.managerId && approvalLevels >= 1) {
        const manager = await User.findById(reportUser.managerId);
        if (manager && manager.status === 'ACTIVE') {
          approvers.push({
            level: 1,
            userId: manager._id as mongoose.Types.ObjectId,
            role: manager.role,
          });
          logger.info({
            employeeId: reportUser._id,
            managerId: manager._id,
            managerRole: manager.role
          }, 'Assigned manager as Level 1 approver');
        } else {
          logger.warn({
            employeeId: reportUser._id,
            managerId: reportUser.managerId,
            managerStatus: manager?.status
          }, 'Manager not found or inactive, skipping Level 1 approver assignment');
        }
      } else {
        logger.warn({
          employeeId: reportUser._id,
          hasManagerId: !!reportUser.managerId,
          approvalLevels
        }, 'Employee has no managerId or approvalLevels < 1, cannot assign Level 1 approver');
      }

      // Level 2: Business Head Approval (always required)
      // Business Head is ALWAYS determined by department ownership.
      // After Manager (L1) approval, system automatically assigns the Business Head.
      // Manager does not choose the BH manually.
      // 
      // Selection Priority:
      // 1. Custom Approver Mapping (L2 if defined)
      // 2. Active BUSINESS_HEAD in same department as employee
      // 3. Manager's manager (if role = BUSINESS_HEAD)
      // 4. Fallback to any active BUSINESS_HEAD or ADMIN in company
      if (approvers.length > 0 && approvalLevels >= 2) {
        const businessHead = await BusinessHeadSelectionService.selectBusinessHead(
          (reportUser._id as mongoose.Types.ObjectId).toString(),
          reportUser.companyId?.toString(),
          customMapping,
          reportUser.managerId?.toString()
        );

        if (businessHead) {
          approvers.push({
            level: 2,
            userId: businessHead._id as mongoose.Types.ObjectId,
            role: businessHead.role,
          });
        } else {
          // Log warning if no BH found, but don't fail - let higher levels handle it
          logger.warn(
            { userId: reportUser._id, companyId: reportUser.companyId },
            'No Business Head found for Level 2 approval - report may require manual assignment'
          );
        }
      }

      // Level 3-5: Use approvalMatrix if configured, otherwise use hierarchy
      if (approvalMatrix) {
        // Use approvalMatrix configuration for optional levels
        const optionalLevels = [
          { level: 3, config: approvalMatrix.level3 },
          { level: 4, config: approvalMatrix.level4 },
          { level: 5, config: approvalMatrix.level5 },
        ];

        for (const { level, config } of optionalLevels) {
          if (config?.enabled && config.approverRoles && config.approverRoles.length > 0) {
            // Find approver with one of the specified roles
            const approver = await User.findOne({
              companyId: reportUser.companyId,
              role: { $in: config.approverRoles },
              status: 'ACTIVE',
              _id: { $nin: approvers.map(a => a.userId) }, // Don't duplicate
            }).exec();

            if (approver) {
              approvers.push({
                level,
                userId: approver._id as mongoose.Types.ObjectId,
                role: approver.role,
              });
            } else {
              // If no approver found for this level, stop here
              break;
            }
          }
        }
      } else {
        // Legacy: Build chain based on hierarchy for levels 3-5
        for (let level = 3; level <= approvalLevels; level++) {
          if (approvers.length > 0) {
            const lastApprover = approvers[approvers.length - 1];
            const lastApproverUser = await User.findById(lastApprover.userId);
            if (lastApproverUser && lastApproverUser.managerId) {
              const nextApprover = await User.findById(lastApproverUser.managerId);
              if (nextApprover && nextApprover.status === 'ACTIVE') {
                approvers.push({
                  level,
                  userId: nextApprover._id as mongoose.Types.ObjectId,
                  role: nextApprover.role,
                });
              } else {
                break; // Stop if no more approvers in chain
              }
            } else {
              break; // Stop if no more approvers in chain
            }
          } else {
            break; // Stop if no base approver found
          }
        }
      }
    }

    // STEP 3: Amount-based validation - if total > INR 5,000, use next enabled level
    const AMOUNT_THRESHOLD = 5000;
    if (report.totalAmount > AMOUNT_THRESHOLD) {
      const maxLevel = approvers.length > 0 ? Math.max(...approvers.map(a => a.level)) : 0;

      // If approvalMatrix is configured, use next enabled level
      if (approvalMatrix) {
        const nextLevel = maxLevel + 1;
        let nextLevelConfig: { enabled: boolean; approverRoles: string[] } | null = null;

        if (nextLevel === 3 && approvalMatrix.level3?.enabled) {
          nextLevelConfig = approvalMatrix.level3;
        } else if (nextLevel === 4 && approvalMatrix.level4?.enabled) {
          nextLevelConfig = approvalMatrix.level4;
        } else if (nextLevel === 5 && approvalMatrix.level5?.enabled) {
          nextLevelConfig = approvalMatrix.level5;
        }

        if (nextLevelConfig && nextLevelConfig.approverRoles && nextLevelConfig.approverRoles.length > 0) {
          const additionalApprover = await User.findOne({
            companyId: reportUser.companyId,
            role: { $in: nextLevelConfig.approverRoles },
            status: 'ACTIVE',
            _id: { $nin: approvers.map(a => a.userId) }, // Don't duplicate
          }).exec();

          if (additionalApprover) {
            approvers.push({
              level: nextLevel,
              userId: additionalApprover._id as mongoose.Types.ObjectId,
              role: additionalApprover.role,
              isAdditionalApproval: true,
              triggerReason: `Report amount (₹${report.totalAmount.toLocaleString('en-IN')}) exceeds threshold (₹${AMOUNT_THRESHOLD.toLocaleString('en-IN')})`,
            });
          }
        } else {
          // Fallback: Find Business Head or Admin if no enabled level matches
          const additionalApprover = await User.findOne({
            companyId: reportUser.companyId,
            role: { $in: [UserRole.BUSINESS_HEAD, UserRole.ADMIN, UserRole.COMPANY_ADMIN] },
            status: 'ACTIVE',
            _id: { $nin: approvers.map(a => a.userId) }, // Don't duplicate
          }).exec();

          if (additionalApprover) {
            approvers.push({
              level: maxLevel + 1,
              userId: additionalApprover._id as mongoose.Types.ObjectId,
              role: additionalApprover.role,
              isAdditionalApproval: true,
              triggerReason: `Report amount (₹${report.totalAmount.toLocaleString('en-IN')}) exceeds threshold (₹${AMOUNT_THRESHOLD.toLocaleString('en-IN')})`,
            });
          }
        }
      } else {
        // Legacy: Add one more level
        const requiredLevels = approvalLevels + 1;
        if (maxLevel < requiredLevels && reportUser.companyId) {
          const additionalApprover = await User.findOne({
            companyId: reportUser.companyId,
            role: { $in: [UserRole.BUSINESS_HEAD, UserRole.ADMIN, UserRole.COMPANY_ADMIN] },
            status: 'ACTIVE',
            _id: { $nin: approvers.map(a => a.userId) }, // Don't duplicate
          }).exec();

          if (additionalApprover) {
            approvers.push({
              level: requiredLevels,
              userId: additionalApprover._id as mongoose.Types.ObjectId,
              role: additionalApprover.role,
              isAdditionalApproval: true,
              triggerReason: `Report amount (₹${report.totalAmount.toLocaleString('en-IN')}) exceeds threshold (₹${AMOUNT_THRESHOLD.toLocaleString('en-IN')})`,
            });
          }
        }
      }
    }

    // STEP 4: Evaluate additional approval rules (budget-based)
    // Additional approvers are added AFTER L1 and L2 (or after the last normal approver if L3-L5 exist)
    if (reportUser.companyId) {
      const additionalApprovers = await this.evaluateAdditionalApprovalRules(report, reportUser.companyId);
      // Exclude additional approvers who are already in the active chain so approval is not shown again
      const existingUserIds = new Set(approvers.map((a) => (a.userId as any)?.toString?.() ?? String(a.userId)));
      const newAdditional = additionalApprovers.filter(
        (a) => !existingUserIds.has((a.userId as any)?.toString?.() ?? String(a.userId))
      );

      if (newAdditional.length > 0) {
        // Find the level after which to insert additional approvers
        // Ensure they come after at least L2 (level 2)
        const maxLevel = approvers.length > 0 ? Math.max(...approvers.map(a => a.level)) : 0;
        const insertAfterLevel = Math.max(maxLevel, 2); // At minimum, insert after L2

        newAdditional.forEach((additionalApprover, index) => {
          approvers.push({
            ...additionalApprover,
            level: insertAfterLevel + index + 1, // Ensure additional approvals come after L2 (or last normal approver)
          });
        });

        logger.info({
          reportId: report._id,
          additionalApproversCount: newAdditional.length,
          insertAfterLevel,
          totalApprovers: approvers.length,
        }, 'Additional approvers added after L2');
      }
    }

    // STEP 5: Fallback - if no approvers found, assign to ADMIN or COMPANY_ADMIN
    if (approvers.length === 0) {
      const admin = await User.findOne({
        role: { $in: [UserRole.ADMIN, UserRole.COMPANY_ADMIN] },
        status: 'ACTIVE',
        companyId: reportUser.companyId,
      });
      if (admin) {
        approvers.push({
          level: 1,
          userId: admin._id as mongoose.Types.ObjectId,
          role: admin.role,
        });
      }
    }

    // Sort approvers by level
    approvers.sort((a, b) => a.level - b.level);

    return approvers;
  }

  /**
   * Evaluate additional approval rules based on budget thresholds
   * Returns additional approvers that should be added to the approval chain
   */
  static async evaluateAdditionalApprovalRules(
    report: IExpenseReport,
    companyId: mongoose.Types.ObjectId
  ): Promise<IApprover[]> {
    const additionalApprovers: IApprover[] = [];

    try {
      // Get all active approval rules for this company
      const activeRules = await ApprovalRule.find({
        companyId,
        active: true,
      }).exec();

      if (activeRules.length === 0) {
        return additionalApprovers;
      }

      // Evaluate each rule
      for (const rule of activeRules) {
        let shouldTrigger = false;
        let triggerReason = '';

        switch (rule.triggerType) {
          case ApprovalRuleTriggerType.REPORT_AMOUNT_EXCEEDS:
            if (report.totalAmount >= rule.thresholdValue) {
              shouldTrigger = true;
              triggerReason = `Report total (₹${report.totalAmount.toLocaleString('en-IN')}) exceeds threshold (₹${rule.thresholdValue.toLocaleString('en-IN')})`;
            }
            break;

          case ApprovalRuleTriggerType.PROJECT_BUDGET_EXCEEDS:
            if (report.projectId) {
              const project = await Project.findById(report.projectId).exec();
              if (project && project.budget && project.thresholdPercentage) {
                // Calculate what the spent amount would be after this report is approved
                const currentSpent = project.spentAmount || 0;
                const projectedSpent = currentSpent + report.totalAmount;
                const thresholdAmount = (project.budget * project.thresholdPercentage) / 100;

                if (projectedSpent >= thresholdAmount) {
                  shouldTrigger = true;
                  triggerReason = `Project budget threshold (${project.thresholdPercentage}% = ₹${thresholdAmount.toLocaleString('en-IN')}) will be exceeded`;
                }
              }
            }
            break;

          case ApprovalRuleTriggerType.COST_CENTRE_BUDGET_EXCEEDS:
            if (report.costCentreId) {
              const costCentre = await CostCentre.findById(report.costCentreId).exec();
              if (costCentre && costCentre.budget && costCentre.thresholdPercentage) {
                // Calculate what the spent amount would be after this report is approved
                const currentSpent = costCentre.spentAmount || 0;
                const projectedSpent = currentSpent + report.totalAmount;
                const thresholdAmount = (costCentre.budget * costCentre.thresholdPercentage) / 100;

                if (projectedSpent >= thresholdAmount) {
                  shouldTrigger = true;
                  triggerReason = `Cost centre budget threshold (${costCentre.thresholdPercentage}% = ₹${thresholdAmount.toLocaleString('en-IN')}) will be exceeded`;
                }
              }
            }
            break;
        }

        // If rule should trigger, find an approver (specific user when set, else by role)
        if (shouldTrigger) {
          const approver = await this.findAdditionalApprover(
            companyId,
            rule.approverRole,
            rule.approverRoleId,
            rule.approverUserId
          );

          if (approver) {
            // Check if this approver is already in the chain to avoid duplicates
            const isDuplicate = additionalApprovers.some(
              a => a.userId.toString() === approver._id.toString()
            );

            if (!isDuplicate) {
              // Get role name - if custom role is specified, get the role name from Role model
              let roleName = approver.role; // Default to user's system role
              if (rule.approverRoleId) {
                const { Role } = await import('../models/Role');
                const customRole = await Role.findById(rule.approverRoleId).select('name').exec();
                if (customRole && customRole.name) {
                  roleName = customRole.name; // Use custom role name
                }
              } else if (rule.approverRole) {
                // Map system role enum to readable name
                const roleMap: Record<ApprovalRuleApproverRole, string> = {
                  [ApprovalRuleApproverRole.ADMIN]: 'Admin',
                  [ApprovalRuleApproverRole.BUSINESS_HEAD]: 'Business Head',
                  [ApprovalRuleApproverRole.ACCOUNTANT]: 'Accountant',
                  [ApprovalRuleApproverRole.COMPANY_ADMIN]: 'Company Admin',
                };
                roleName = roleMap[rule.approverRole] || approver.role;
              }

              additionalApprovers.push({
                level: 0, // Will be set correctly in computeApproverChain
                userId: approver._id as mongoose.Types.ObjectId,
                role: roleName, // Use the resolved role name (custom role name or system role)
                isAdditionalApproval: true,
                approvalRuleId: rule._id as mongoose.Types.ObjectId,
                triggerReason: triggerReason || rule.description || 'Budget oversight approval required',
              });
            }
          }
        }
      }
    } catch (error) {
      logger.error({ error, reportId: report._id, companyId }, 'Error evaluating additional approval rules');
      // Don't throw - if rule evaluation fails, continue with normal approval chain
    }

    return additionalApprovers;
  }

  /**
   * Find an approver with the specified role for additional approvals
   * When approverUserId is set, returns that user (no random pick). Otherwise uses role.
   */
  static async findAdditionalApprover(
    companyId: mongoose.Types.ObjectId,
    approverRole?: ApprovalRuleApproverRole,
    approverRoleId?: mongoose.Types.ObjectId,
    approverUserId?: mongoose.Types.ObjectId
  ): Promise<any> {
    // When a specific user is chosen (role has multiple users), use that user
    if (approverUserId) {
      const user = await User.findOne({
        _id: approverUserId,
        companyId,
        status: 'ACTIVE',
      }).exec();
      return user ?? null;
    }

    // If custom role is specified, find first user with that custom role (legacy / single-user role)
    if (approverRoleId) {
      const approver = await User.findOne({
        companyId,
        roles: approverRoleId,
        status: 'ACTIVE',
      }).populate('roles').exec();

      return approver;
    }

    // Fallback to system role mapping (for backward compatibility)
    if (approverRole) {
      // Map ApprovalRuleApproverRole to UserRole
      const roleMap: Record<ApprovalRuleApproverRole, UserRole[]> = {
        [ApprovalRuleApproverRole.ADMIN]: [UserRole.ADMIN],
        [ApprovalRuleApproverRole.BUSINESS_HEAD]: [UserRole.BUSINESS_HEAD],
        [ApprovalRuleApproverRole.ACCOUNTANT]: [UserRole.ACCOUNTANT],
        [ApprovalRuleApproverRole.COMPANY_ADMIN]: [UserRole.COMPANY_ADMIN],
      };

      const targetRoles = roleMap[approverRole] || [];

      if (targetRoles.length === 0) {
        return null;
      }

      // Find first active user with the target role in the company
      const approver = await User.findOne({
        companyId,
        role: { $in: targetRoles },
        status: 'ACTIVE',
      }).exec();

      return approver;
    }

    return null;
  }

  static async submitReport(id: string, userId: string, data?: { advanceCashId?: string; advanceAmount?: number }): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(id);

    if (!report) {
      throw new Error('Report not found');
    }

    if (report.userId.toString() !== userId) {
      throw new Error('Access denied');
    }

    // Allow submitting if report is DRAFT or CHANGES_REQUESTED (for resubmission)
    const canSubmit =
      report.status === ExpenseReportStatus.DRAFT ||
      report.status === ExpenseReportStatus.CHANGES_REQUESTED;

    if (!canSubmit) {
      throw new Error('Cannot submit this report in its current status');
    }

    // If report was previously CHANGES_REQUESTED, check if there are any PENDING or REJECTED expenses
    // These must be addressed before resubmission
    if (report.status === ExpenseReportStatus.CHANGES_REQUESTED) {
      const pendingExpensesCount = await Expense.countDocuments({
        reportId: id,
        status: ExpenseStatus.PENDING
      });

      const rejectedExpensesCount = await Expense.countDocuments({
        reportId: id,
        status: ExpenseStatus.REJECTED
      });

      if (pendingExpensesCount > 0) {
        throw new Error('Please update all expenses that need changes before resubmitting');
      }

      if (rejectedExpensesCount > 0) {
        throw new Error('Please update or delete all rejected expenses before resubmitting');
      }
    }

    // Validate: must have at least one expense
    const expenseCount = await Expense.countDocuments({ reportId: id });
    if (expenseCount === 0) {
      throw new Error('Report must have at least one expense');
    }

    // Duplicate detection: flag-only, never block. Update expenses with duplicateFlag/duplicateReason.
    const reportUser = await User.findById(report.userId).select('companyId').exec();
    if (reportUser && reportUser.companyId) {
      try {
        const { DuplicateDetectionService } = await import('./duplicateDetection.service');
        await DuplicateDetectionService.runReportDuplicateCheck(id, reportUser.companyId as mongoose.Types.ObjectId);
      } catch (e) {
        logger.warn({ err: e, reportId: id }, 'Report duplicate check failed; continuing');
      }
    }

    // Handle voucher application (NEW voucher system)
    // Voucher can only be applied when report is in DRAFT status
    // MUST be done BEFORE status change
    if (data?.advanceCashId && data.advanceAmount && data.advanceAmount > 0) {
      if (report.status !== ExpenseReportStatus.DRAFT) {
        throw new Error('Voucher can only be applied to DRAFT reports');
      }

      try {
        const { VoucherService } = await import('./voucher.service');
        await VoucherService.applyVoucherToReport({
          voucherId: data.advanceCashId,
          reportId: id,
          amount: data.advanceAmount,
          userId,
        });
        logger.info({
          reportId: id,
          voucherId: data.advanceCashId,
          voucherAmount: data.advanceAmount,
        }, 'Voucher applied to report via VoucherService');
        // Notify report owner: voucher applied (plan §6.2). Never block.
        await NotificationService.ensureNotify(
          async () => {
            const r = await ExpenseReport.findById(id).exec();
            if (r) await NotificationService.notifyVoucherApplied(r);
          },
          'voucher_applied'
        );
      } catch (error: any) {
        logger.error({
          error: error.message,
          reportId: id,
          voucherId: data.advanceCashId,
        }, 'Failed to apply voucher to report');
        throw error; // Re-throw to prevent submission if voucher application fails
      }

      // Refresh report instance to get latest version (since applyVoucherToReport modified it)
      const refreshedReport = await ExpenseReport.findById(id);
      if (refreshedReport) {
        // Update local properties that might be used later
        report.appliedVouchers = refreshedReport.appliedVouchers;
        report.advanceCashId = refreshedReport.advanceCashId;
        report.advanceAppliedAmount = refreshedReport.advanceAppliedAmount;
        report.advanceCurrency = refreshedReport.advanceCurrency;
        // Important: update version key to avoid VersionError on save
        report.increment(); // Or just replace the object?
        // Better to just replace the object properties or restart with fresh object, 
        // but 'report' is const reference to the object? No it is from findById.
        // Let's just update the internal state or re-assign if it was let.
        // Since 'report' is const (from line 1260), we can't reassign it.
        // But we can mutate it or use the refreshed one.
        // However, subsequent code uses 'report'. 
        // We should manually sync the version and modified fields.
        (report as any).__v = refreshedReport.__v;
      }
    }

    // Track approvers for audit/logging without relying on a scoped variable
    let approvalInstanceIdForAudit: string | undefined;

    // Use the NEW Approval Matrix System
    if (reportUser && reportUser.companyId) {
      try {
        // CRITICAL: Compute additional approvers from approval rules BEFORE clearing approvers array
        // This ensures additional approvers are saved even when using ApprovalMatrix
        const additionalApprovers = await this.evaluateAdditionalApprovalRules(
          report,
          reportUser.companyId as mongoose.Types.ObjectId
        );

        // Personalized matrix: use employee's approval profile when set (includes selected approver users per level)
        let effectiveMatrixLevels: Array<{ levelNumber: number; enabled: boolean; approvalType: string; parallelRule?: string; approverRoleIds: mongoose.Types.ObjectId[]; approverUserIds: mongoose.Types.ObjectId[]; conditions: any[]; skipAllowed: boolean }> | null = null;
        const profile = await EmployeeApprovalProfileService.getActive(
          (report.userId as mongoose.Types.ObjectId).toString(),
          reportUser.companyId.toString()
        );
        if (profile?.approverChain?.length) {
          effectiveMatrixLevels = this.buildEffectiveLevelsFromProfile(profile.approverChain as any);
          logger.info({
            reportId: id,
            userId: report.userId,
            levelsCount: effectiveMatrixLevels.length,
          }, 'Using personalized approval matrix for report submission');
        } else {
          // Company matrix: always fetch and build effectiveMatrixLevels for consistent approval chain
          const { ApprovalMatrix } = await import('../models/ApprovalMatrix');
          const matrix = await ApprovalMatrix.findOne({
            companyId: reportUser.companyId,
            isActive: true,
          }).exec();
          if (matrix?.levels?.length) {
            const customMapping = await ApproverMapping.findOne({
              userId: report.userId,
              companyId: reportUser.companyId,
              isActive: true,
            }).exec();
            if (customMapping) {
              // Merge ApproverMapping overrides when user has custom approver mapping
              const levelApproverIds = [
                customMapping.level1ApproverId,
                customMapping.level2ApproverId,
                customMapping.level3ApproverId,
                customMapping.level4ApproverId,
                customMapping.level5ApproverId,
              ];
              effectiveMatrixLevels = matrix.levels.map((lvl: any) => {
                const mappingApproverId = levelApproverIds[(lvl.levelNumber || 1) - 1];
                const approverUserIds = mappingApproverId
                  ? [mappingApproverId]
                  : (lvl.approverUserIds || []).length > 0
                    ? lvl.approverUserIds
                    : lvl.approverRoleIds || [];
                return {
                  ...lvl,
                  approverUserIds: Array.isArray(approverUserIds)
                    ? approverUserIds.map((id: any) => (id?._id ?? id))
                    : [],
                  approverRoleIds: mappingApproverId ? [] : (lvl.approverRoleIds || []),
                };
              });
              logger.info({
                reportId: id,
                userId: report.userId,
                levelsCount: effectiveMatrixLevels.length,
                source: 'ApproverMapping + company matrix',
              }, 'Using company matrix with ApproverMapping overrides for report submission');
            } else {
              // Normal company matrix (no custom mapping): build effectiveMatrixLevels from company matrix
              // Preserve both approverUserIds and approverRoleIds for backend resolution (handles
              // MatrixBuilder migration where approverUserIds may contain role IDs)
              effectiveMatrixLevels = matrix.levels.map((lvl: any) => ({
                ...lvl,
                approverUserIds: Array.isArray(lvl.approverUserIds)
                  ? lvl.approverUserIds.map((id: any) => (id?._id ?? id))
                  : [],
                approverRoleIds: Array.isArray(lvl.approverRoleIds) ? lvl.approverRoleIds : [],
              }));
              logger.info({
                reportId: id,
                userId: report.userId,
                levelsCount: effectiveMatrixLevels.length,
                source: 'company matrix',
              }, 'Using normal company approval matrix for report submission');
            }
          }
        }

        const initialData: any = effectiveMatrixLevels
          ? { requestData: report, effectiveMatrix: { levels: effectiveMatrixLevels } }
          : report;

        // Initiate approval using the ApprovalService (Matrix-based or personalized)
        const approvalInstance = await ApprovalService.initiateApproval(
          reportUser.companyId.toString(),
          id,
          'EXPENSE_REPORT',
          initialData
        );
        approvalInstanceIdForAudit = (approvalInstance._id as any)?.toString?.() || String(approvalInstance._id);

        logger.info({
          reportId: id,
          userId,
          approvalInstanceId: approvalInstance._id,
          currentLevel: approvalInstance.currentLevel,
          status: approvalInstance.status,
          additionalApproversCount: additionalApprovers.length
        }, 'Approval instance created via ApprovalService');

        // Set initial status based on approval instance status
        if (approvalInstance.status === 'PENDING') {
          report.status = ExpenseReportStatus.PENDING_APPROVAL_L1;
        } else if (approvalInstance.status === 'APPROVED') {
          // Matrix has no levels or all levels skipped - auto-approved
          report.status = ExpenseReportStatus.APPROVED;
          report.approvedAt = new Date();
        } else {
          report.status = ExpenseReportStatus.SUBMITTED;
        }

        // CRITICAL: Save additional approvers to report even when using ApprovalMatrix
        // This allows the approval UI to show additional approver remarks
        // Additional approvers are added after L2 (or after last normal approver)
        if (additionalApprovers.length > 0) {
          // Get the max level from effective matrix (personalized) or company ApprovalMatrix
          let maxLevel = 2; // Default to L2
          if (effectiveMatrixLevels?.length) {
            maxLevel = Math.max(...effectiveMatrixLevels.map((l) => l.levelNumber), 2);
          } else {
            const { ApprovalMatrix } = await import('../models/ApprovalMatrix');
            const matrix = await ApprovalMatrix.findOne({
              companyId: reportUser.companyId,
              isActive: true
            }).exec();
            if (matrix && matrix.levels) {
              const enabledLevels = matrix.levels
                .filter((l: any) => l.enabled !== false)
                .map((l: any) => l.levelNumber);
              if (enabledLevels.length > 0) {
                maxLevel = Math.max(...enabledLevels);
              }
            }
          }

          const insertAfterLevel = Math.max(maxLevel, 2); // At minimum, insert after L2

          // Set approvers array with additional approvers (for UI display and notifications)
          report.approvers = additionalApprovers.map((additionalApprover, index) => ({
            ...additionalApprover,
            level: insertAfterLevel + index + 1, // Ensure additional approvals come after L2 (or last normal approver)
          }));

          logger.info({
            reportId: id,
            additionalApproversCount: additionalApprovers.length,
            insertAfterLevel,
            approvers: report.approvers.map((a: any) => ({
              level: a.level,
              role: a.role,
              triggerReason: a.triggerReason
            }))
          }, 'Additional approvers saved to report for ApprovalMatrix flow');
        } else {
          // No additional approvers - clear the array
          report.approvers = [];
        }

      } catch (error: any) {
        logger.error({
          error: error.message,
          stack: error.stack,
          reportId: id,
          companyId: reportUser.companyId.toString()
        }, 'Failed to initiate approval via ApprovalService');

        // If ApprovalService fails, fall back to the old manual system
        logger.warn({ reportId: id }, 'Falling back to manual approval chain computation');
        const approvers = await this.computeApproverChain(report);

        if (approvers.length === 0) {
          logger.error({ reportId: id, userId }, 'No approvers found for report (fallback)');
          throw new Error('No approvers found for this report. Please ensure an approval matrix is configured or assign a manager to your account.');
        }

        report.approvers = approvers;
        report.status = ExpenseReportStatus.PENDING_APPROVAL_L1;
      }
    } else {
      // No company - shouldn't happen, but fallback to old system
      logger.warn({ reportId: id, userId }, 'Report user has no company, using fallback approval');
      const approvers = await this.computeApproverChain(report);

      if (approvers.length === 0) {
        throw new Error('No approvers found for this report. Please ensure an approval matrix is configured or assign a manager to your account.');
      }

      report.approvers = approvers;
      report.status = ExpenseReportStatus.PENDING_APPROVAL_L1;
    }

    report.submittedAt = new Date();
    report.updatedBy = new mongoose.Types.ObjectId(userId);

    logger.info({
      reportId: id,
      status: report.status,
      approversCount: report.approvers.length
    }, 'Report status set and ready to save');

    const saved = await report.save();

    await AuditService.log(
      userId,
      'ExpenseReport',
      id,
      AuditAction.STATUS_CHANGE,
      {
        status: saved.status,
        approvers: (saved.approvers || []).map((a: any) => ({
          level: a.level,
          userId: a.userId?.toString ? a.userId.toString() : String(a.userId),
        })),
        approvalInstanceId: approvalInstanceIdForAudit,
      }
    );

    // Notify approvers - reload report to ensure approvers are properly serialized
    try {
      logger.info({ reportId: saved._id, approversCount: saved.approvers.length }, 'Sending notifications to approvers');

      // Reload report to ensure all fields are properly populated
      const reportForNotification = await ExpenseReport.findById(saved._id).exec();
      if (!reportForNotification) {
        logger.error({ reportId: saved._id }, 'Report not found after save, cannot send notifications');
      } else {
        logger.info({
          reportId: reportForNotification._id,
          approversCount: reportForNotification.approvers.length,
          approvers: reportForNotification.approvers.map((a: any) => ({
            level: a.level,
            userId: a.userId?.toString ? a.userId.toString() : String(a.userId),
            role: a.role,
            decidedAt: a.decidedAt
          }))
        }, 'Report loaded for notification, approvers verified');

        logger.info({ reportId: saved._id }, '🔔 Calling notification service for report submission');
        await NotificationService.notifyReportSubmitted(reportForNotification);
        // Notify additional approvers when budget/amount rules trigger (plan §6.2)
        const additional = (reportForNotification.approvers || []).filter(
          (a: any) => a.isAdditionalApproval && a.userId
        );
        if (additional.length > 0) {
          await NotificationService.ensureNotify(
            () =>
              NotificationService.notifyAdditionalApproverAdded(
                reportForNotification,
                additional.map((a: any) => ({
                  userId: (a.userId as any)?.toString?.() ?? String(a.userId),
                  role: a.role,
                  triggerReason: a.triggerReason,
                }))
              ),
            'additional_approver_added'
          );
        }
        logger.info({ reportId: saved._id }, '✅ Notifications sent successfully');
      }
    } catch (error) {
      logger.error({ error, reportId: saved._id, stack: (error as any)?.stack }, 'Error sending notifications to approvers');
      // Don't fail report submission if notifications fail
    }

    // Emit real-time events to managers
    try {
      // Get the user who submitted the report
      const reportUser = await User.findById(report.userId).select('managerId').exec();

      if (reportUser && reportUser.managerId) {
        // Emit to manager that a report was submitted
        const populatedReport = await ExpenseReport.findById(saved._id)
          .populate('userId', 'name email')
          .populate('projectId', 'name code')
          .exec();

        if (populatedReport) {
          emitManagerReportUpdate(reportUser.managerId.toString(), 'submitted', populatedReport);
          emitManagerDashboardUpdate(reportUser.managerId.toString());
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error emitting manager real-time events');
      // Don't fail report submission if real-time events fail
    }

    // Enqueue analytics update (REPORT_SUBMITTED)
    try {
      if (reportUser && reportUser.companyId) {
        enqueueAnalyticsEvent({
          companyId: reportUser.companyId.toString(),
          event: 'REPORT_SUBMITTED',
        });
      }
    } catch (error) {
      logger.error({ error }, 'Error enqueueing analytics update after submit');
    }

    return saved;
  }

  /**
   * Get available vouchers for a report (only when report is DRAFT)
   */
  static async getVoucherSelectionForReport(reportId: string, userId: string): Promise<any[]> {
    const report = await ExpenseReport.findById(reportId).exec();

    if (!report) {
      throw new Error('Report not found');
    }

    if (report.userId.toString() !== userId) {
      throw new Error('Access denied');
    }

    // Only allow voucher selection when report is DRAFT
    if (report.status !== ExpenseReportStatus.DRAFT) {
      throw new Error('Vouchers can only be selected for DRAFT reports');
    }

    // Get user's company
    const user = await User.findById(userId).select('companyId').exec();
    if (!user || !user.companyId) {
      throw new Error('User company not found');
    }

    // Get available vouchers
    const { VoucherService } = await import('./voucher.service');
    const vouchers = await VoucherService.getAvailableVouchers({
      companyId: user.companyId.toString(),
      employeeId: userId,
      reportId,
      currency: report.currency,
      projectId: report.projectId?.toString(),
      costCentreId: report.costCentreId?.toString(),
    });

    return vouchers.map((v: any) => {
      const total = v.totalAmount ?? v.amount ?? 0;
      const used = v.usedAmount ?? 0;
      const remaining =
        v.status === 'EXHAUSTED' ? 0 : Math.max(0, total - used);
      return {
        _id: v._id,
        voucherCode: v.voucherCode,
        totalAmount: total,
        remainingAmount: remaining,
        usedAmount: used,
        currency: v.currency,
        status: v.status,
        projectId: v.projectId,
        costCentreId: v.costCentreId,
        createdAt: v.createdAt,
        amount: total,
        balance: remaining,
      };
    });
  }

  static async handleReportAction(
    id: string,
    userId: string,
    action: 'approve' | 'reject' | 'request_changes',
    comment?: string
  ): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(id)
      .populate('userId', 'companyId')
      .exec();

    if (!report) {
      throw new Error('Report not found');
    }

    // SECURITY: Verify approver is from same company as report
    const reportUser = await User.findById(report.userId).select('companyId').exec();
    const approverUser = await User.findById(userId).select('companyId').exec();

    if (!reportUser || !approverUser) {
      throw new Error('Invalid user or approver');
    }

    // SUPER_ADMIN can approve any report, but all other roles must be from same company
    if (approverUser.role !== 'SUPER_ADMIN') {
      const reportCompanyId = reportUser.companyId?.toString();
      const approverCompanyId = approverUser.companyId?.toString();

      if (reportCompanyId !== approverCompanyId) {
        logger.warn({
          reportId: id,
          approverId: userId,
          reportCompanyId,
          approverCompanyId,
        }, 'Attempt to approve report from different company - denied');
        throw new Error('You can only approve reports from your company');
      }
    }

    // Check if user is an approver
    const approverIndex = report.approvers.findIndex(
      (a) => a.userId.toString() === userId && !a.decidedAt
    );

    if (approverIndex === -1) {
      throw new Error('You are not authorized to approve/reject this report');
    }

    const approver = report.approvers[approverIndex];
    const currentLevel = approver.level;

    // Update approver record
    approver.decidedAt = new Date();
    approver.action = action;
    approver.comment = comment;

    // Handle action
    if (action === 'reject') {
      report.status = ExpenseReportStatus.REJECTED;
      report.rejectedAt = new Date();

      // Reverse all voucher usages for this report
      try {
        const { VoucherService } = await import('./voucher.service');
        await VoucherService.reverseVoucherUsageForReport(
          id,
          userId,
          comment || 'Report rejected by approver'
        );
        logger.info({ reportId: id }, 'Voucher usages reversed for rejected report');
      } catch (error) {
        logger.error(
          { error, reportId: id },
          'Failed to reverse voucher usages for rejected report'
        );
        // Don't fail report rejection if voucher reversal fails, but log the error
        // The report will still be rejected, but vouchers may need manual correction
      }

      // Release receipt hashes for all expenses in rejected report
      try {
        const { ReceiptDuplicateDetectionService } = await import('./receiptDuplicateDetection.service');
        await ReceiptDuplicateDetectionService.releaseReceiptHashesForReport(id);
      } catch (error) {
        logger.error({ error, reportId: id }, 'Failed to release receipt hashes for rejected report');
        // Don't fail report rejection if hash release fails
      }
    } else if (action === 'approve') {
      // Check if this is the last approver
      const totalLevels = Math.max(...report.approvers.map(a => a.level));
      if (currentLevel >= totalLevels) {
        // Final approval
        report.status = ExpenseReportStatus.APPROVED;
        report.approvedAt = new Date();
      } else {
        // Move to next level - use PENDING_APPROVAL_LX statuses
        const nextLevel = currentLevel + 1;
        if (nextLevel === 1) {
          report.status = ExpenseReportStatus.PENDING_APPROVAL_L1;
        } else if (nextLevel === 2) {
          report.status = ExpenseReportStatus.PENDING_APPROVAL_L2;
        } else if (nextLevel === 3) {
          report.status = ExpenseReportStatus.PENDING_APPROVAL_L3;
        } else if (nextLevel === 4) {
          report.status = ExpenseReportStatus.PENDING_APPROVAL_L4;
        } else if (nextLevel === 5) {
          report.status = ExpenseReportStatus.PENDING_APPROVAL_L5;
        } else {
          // Fallback to old statuses for backward compatibility
          if (nextLevel === 1) {
            report.status = ExpenseReportStatus.MANAGER_APPROVED;
          } else if (nextLevel === 2) {
            report.status = ExpenseReportStatus.BH_APPROVED;
          }
        }
      }
    } else if (action === 'request_changes') {
      // Comment is mandatory when requesting changes
      if (!comment || !comment.trim()) {
        const error: any = new Error('Comment is required when requesting changes');
        error.statusCode = 400;
        error.code = 'COMMENT_REQUIRED';
        throw error;
      }

      // Reset approval chain - will be recomputed on resubmission
      // This ensures that if employee structure changes, new approvers are assigned
      report.approvers = [];

      // Set status to CHANGES_REQUESTED (not DRAFT) to indicate changes are needed
      report.status = ExpenseReportStatus.CHANGES_REQUESTED;

      // Log the approval chain reset for audit purposes
      logger.info(
        { reportId: id, approverId: userId, level: currentLevel },
        'Approval chain reset due to changes requested - will be recomputed on resubmission'
      );
    }

    report.updatedBy = new mongoose.Types.ObjectId(userId);
    const saved = await report.save();

    // Post-approval side-effect: apply advance cash deductions (does not affect approval routing)
    if (saved.status === ExpenseReportStatus.APPROVED) {
      const { AdvanceCashService } = await import('./advanceCash.service');
      await AdvanceCashService.applyAdvanceForReport(id);
    }

    await AuditService.log(
      userId,
      'ExpenseReport',
      id,
      AuditAction.STATUS_CHANGE,
      { action, comment, level: currentLevel, newStatus: saved.status }
    );

    // Notify report owner for final actions
    if (saved.status === ExpenseReportStatus.APPROVED || saved.status === ExpenseReportStatus.REJECTED) {
      await NotificationService.notifyReportStatusChanged(saved, saved.status);
    } else if (action === 'request_changes') {
      // Notify employee when changes are requested
      await NotificationService.notifyReportChangesRequested(saved);
    } else if (action === 'approve') {
      // Notify next approver if report moved to next level
      const nextLevelApprovers = saved.approvers.filter(
        (a: any) => a.level === currentLevel + 1 && !a.decidedAt
      );

      if (nextLevelApprovers.length > 0) {
        await NotificationService.notifyNextApprover(saved, nextLevelApprovers);
      }
    }

    return saved;
  }

  static async adminGetReports(filters: ReportFiltersDto, req: AuthRequest): Promise<any> {
    const { page, pageSize } = getPaginationOptions(filters.page, filters.pageSize);
    const baseQuery: any = {};

    // Company admins should only see reports that are in approval workflow or completed
    // Exclude DRAFT reports by default unless explicitly requested
    if (filters.status) {
      baseQuery.status = filters.status;
    } else {
      // Default: exclude DRAFT status for company admins
      baseQuery.status = {
        $ne: ExpenseReportStatus.DRAFT
      };
    }

    if (filters.userId) {
      // Convert userId string to ObjectId for proper MongoDB querying
      if (mongoose.Types.ObjectId.isValid(filters.userId)) {
        baseQuery.userId = new mongoose.Types.ObjectId(filters.userId);
      } else {
        // Invalid userId, will be filtered out by buildCompanyQuery
        baseQuery.userId = filters.userId;
      }
    }

    if (filters.projectId) {
      baseQuery.projectId = filters.projectId;
    }

    if (filters.from) {
      baseQuery.fromDate = { $gte: new Date(filters.from) };
    }

    if (filters.to) {
      baseQuery.toDate = { $lte: new Date(filters.to) };
    }

    // Add company filter for non-SUPER_ADMIN users
    const query = await buildCompanyQuery(req, baseQuery, 'users');

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

    // If report is rejected, release receipt hashes to allow resubmission
    if (newStatus === ExpenseReportStatus.REJECTED) {
      try {
        const { ReceiptDuplicateDetectionService } = await import('./receiptDuplicateDetection.service');
        await ReceiptDuplicateDetectionService.releaseReceiptHashesForReport(id);
      } catch (error) {
        logger.error({ error, reportId: id }, 'Failed to release receipt hashes for rejected report');
        // Don't fail report rejection if hash release fails
      }
    }

    // If report is approved, approve all expenses in the report and emit real-time events
    if (newStatus === ExpenseReportStatus.APPROVED) {
      try {
        const expenses = await Expense.find({ reportId: new mongoose.Types.ObjectId(id) }).exec();
        const reportUserId = saved.userId.toString();

        // Update all expenses to APPROVED
        await Expense.updateMany(
          { reportId: new mongoose.Types.ObjectId(id) },
          {
            $set: {
              status: ExpenseStatus.APPROVED
            }
          }
        );
        logger.info(`Approved all expenses for report ${id}`);

        // Emit real-time events for each approved expense
        try {
          const { emitExpenseApprovedToEmployee } = await import('../socket/realtimeEvents');
          for (const expense of expenses) {
            const expenseObj = expense.toObject();
            emitExpenseApprovedToEmployee(reportUserId, expenseObj);
          }
        } catch (error) {
          logger.error({ error }, 'Error emitting expense approval events');
        }
      } catch (error) {
        logger.error({ error, reportId: id }, 'Error approving expenses for report');
        // Don't fail report approval if expense update fails
      }

      // Post-approval side-effect: apply advance cash deductions (does not affect approval routing)
      const { AdvanceCashService } = await import('./advanceCash.service');
      await AdvanceCashService.applyAdvanceForReport(id);
    }

    await AuditService.log(
      adminUserId,
      'ExpenseReport',
      id,
      AuditAction.STATUS_CHANGE,
      { status: newStatus }
    );

    // Enqueue analytics update (REPORT_APPROVED or REPORT_REJECTED)
    try {
      const reportUser = await User.findById(saved.userId).select('companyId').exec();
      if (reportUser && reportUser.companyId) {
        const companyId = reportUser.companyId.toString();
        enqueueAnalyticsEvent({
          companyId,
          event: saved.status === ExpenseReportStatus.APPROVED ? 'REPORT_APPROVED' : 'REPORT_REJECTED',
          reportId: id,
        });
      }
    } catch (error) {
      logger.error({ error }, 'Error enqueueing analytics update');
    }

    // Notify employee
    await NotificationService.notifyReportStatusChanged(saved, newStatus);

    return saved;
  }

  static async recalcTotals(reportId: string): Promise<void> {
    // Exclude REJECTED expenses from totals; zero financial impact (plan §4.2)
    const expenses = await Expense.find({ reportId, status: { $ne: ExpenseStatus.REJECTED } });
    const totalAmount = expenses.reduce((sum, exp) => sum + exp.amount, 0);

    await ExpenseReport.findByIdAndUpdate(reportId, { totalAmount });
  }

  static async deleteReport(
    reportId: string,
    userId: string,
    userRole: string
  ): Promise<void> {
    const report = await ExpenseReport.findById(reportId);

    if (!report) {
      throw new Error('Report not found');
    }

    // Check access: owner or admin
    if (
      report.userId.toString() !== userId &&
      userRole !== UserRole.ADMIN &&
      userRole !== UserRole.BUSINESS_HEAD
    ) {
      throw new Error('Access denied');
    }

    // Only allow deletion if report is DRAFT
    if (report.status !== ExpenseReportStatus.DRAFT) {
      throw new Error(`Only draft reports can be deleted. This report has status: ${report.status}`);
    }

    // Delete all expenses associated with this report
    await Expense.deleteMany({ reportId });

    // Get companyId from user before deleting
    const user = await User.findById(userId).select('companyId').exec();
    const reportUserId = report.userId.toString();

    // Delete all expenses associated with this report
    await Expense.deleteMany({ reportId });

    // Delete the report
    await ExpenseReport.findByIdAndDelete(reportId);

    // Log audit
    await AuditService.log(userId, 'ExpenseReport', reportId, AuditAction.DELETE);

    // Enqueue analytics rebuild after report deletion
    try {
      if (user && user.companyId) {
        enqueueAnalyticsEvent({ companyId: user.companyId.toString(), event: 'REBUILD_SNAPSHOT' });
      }
    } catch (error) {
      logger.error({ error }, 'Error enqueueing analytics update after report deletion');
    }

    emitManagerDashboardUpdate(reportUserId);
  }

  /**
   * Process settlement for an approved report
   * Calculates employee paid amount and stores admin settlement decision
   */
  static async processSettlement(
    reportId: string,
    adminId: string,
    decision: {
      type: 'ISSUE_VOUCHER' | 'REIMBURSE' | 'CLOSE';
      comment?: string;
      voucherId?: string; // For ISSUE_VOUCHER - optional, will create new if not provided
      reimbursementAmount?: number; // For REIMBURSE
    }
  ): Promise<IExpenseReport> {
    if (!mongoose.Types.ObjectId.isValid(reportId)) {
      throw new Error(`Invalid report ID format: ${reportId}`);
    }

    if (!mongoose.Types.ObjectId.isValid(adminId)) {
      throw new Error(`Invalid admin ID format: ${adminId}`);
    }

    const reportObjectId = new mongoose.Types.ObjectId(reportId);
    const adminObjectId = new mongoose.Types.ObjectId(adminId);

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Load report with lock
      const report = await ExpenseReport.findById(reportObjectId)
        .session(session)
        .exec();

      if (!report) {
        throw new Error('Report not found');
      }

      // Only allow settlement for APPROVED reports
      if (report.status !== ExpenseReportStatus.APPROVED) {
        const err: any = new Error('Settlement can only be processed for approved reports');
        err.statusCode = 400;
        err.code = 'SETTLEMENT_REPORT_NOT_APPROVED';
        throw err;
      }

      // Calculate voucher total used
      const appliedVouchers = Array.isArray(report.appliedVouchers) ? report.appliedVouchers : [];
      const voucherTotalUsed = appliedVouchers.reduce((sum, v) => sum + (v.amountUsed || 0), 0);

      // Calculate employee paid amount
      const employeePaidAmount = Math.max(0, (report.totalAmount || 0) - voucherTotalUsed);

      // Update report with settlement information
      report.employeePaidAmount = employeePaidAmount;
      report.settlementDecision = {
        type: decision.type,
        decidedBy: adminObjectId,
        decidedAt: new Date(),
        comment: decision.comment,
      };

      // Load user to get companyId (needed for notifications and voucher creation)
      const user = await User.findById(report.userId).select('companyId').exec();
      if (!user || !user.companyId) {
        throw new Error('User company not found');
      }

      // Handle settlement type-specific logic
      if (decision.type === 'ISSUE_VOUCHER') {
        // Create new voucher for employee if voucherId not provided
        if (!decision.voucherId) {
          const { VoucherService } = await import('./voucher.service');

          const newVoucher = await VoucherService.createVoucher({
            companyId: user.companyId.toString(),
            employeeId: report.userId.toString(),
            totalAmount: employeePaidAmount,
            currency: report.currency || 'INR',
            projectId: report.projectId?.toString(),
            costCentreId: report.costCentreId?.toString(),
            createdBy: adminId,
          });

          report.settlementDecision.voucherId = newVoucher._id as mongoose.Types.ObjectId;
          report.settlementStatus = 'ISSUED_VOUCHER';

          logger.info(
            {
              reportId,
              voucherId: newVoucher._id,
              amount: employeePaidAmount,
            },
            'Created new voucher for settlement'
          );
        } else {
          // Use existing voucher
          if (!mongoose.Types.ObjectId.isValid(decision.voucherId)) {
            throw new Error('Invalid voucher ID format');
          }
          report.settlementDecision.voucherId = new mongoose.Types.ObjectId(decision.voucherId);
          report.settlementStatus = 'ISSUED_VOUCHER';
        }
      } else if (decision.type === 'REIMBURSE') {
        report.settlementDecision.reimbursementAmount = decision.reimbursementAmount || employeePaidAmount;
        report.settlementStatus = 'REIMBURSED';
      } else if (decision.type === 'CLOSE') {
        report.settlementStatus = 'CLOSED';
      }

      await report.save({ session });

      // Mark advance cash (vouchers) used in this report as REIMBURSED when settlement is done
      try {
        const { VoucherService } = await import('./voucher.service');
        await VoucherService.markVouchersAsReimbursedForReport(reportId);
      } catch (voucherErr: any) {
        logger.warn({ err: voucherErr?.message ?? voucherErr, reportId }, 'Mark vouchers as reimbursed failed');
      }

      // Log audit entry
      await AuditService.log(
        adminId,
        'ExpenseReport',
        reportId,
        AuditAction.UPDATE,
        {
          action: 'SETTLEMENT_PROCESSED',
          settlementType: decision.type,
          employeePaidAmount,
          voucherTotalUsed,
        }
      );

      await session.commitTransaction();

      logger.info(
        {
          reportId,
          settlementType: decision.type,
          employeePaidAmount,
        },
        'Settlement processed successfully'
      );

      // Enqueue analytics update (SETTLEMENT_COMPLETED)
      try {
        enqueueAnalyticsEvent({
          companyId: user.companyId.toString(),
          event: 'SETTLEMENT_COMPLETED',
          reportId,
        });
      } catch (error) {
        logger.error({ error }, 'Error enqueueing analytics update after settlement');
      }

      // Notify report owner that settlement is done
      try {
        const { NotificationDataService } = await import('./notificationData.service');
        const { NotificationType } = await import('../models/Notification');
        const { NotificationService } = await import('./notification.service');
        const reportOwnerId = report.userId?.toString();
        const reportName = report.name || 'Report';
        const amountText = report.currency && employeePaidAmount != null
          ? `${report.currency} ${employeePaidAmount.toLocaleString()}`
          : `${employeePaidAmount?.toLocaleString() ?? 0}`;
        const description = `Your settlement of ${amountText} for report "${reportName}" is done.`;
        if (reportOwnerId) {
          await NotificationDataService.createNotification({
            userId: reportOwnerId,
            companyId: user.companyId.toString(),
            type: NotificationType.SETTLEMENT_DONE,
            title: 'Settlement completed',
            description,
            link: `/reports/${reportId}`,
            metadata: { reportId, reportName, amount: employeePaidAmount, settlementType: decision.type },
          });
          await NotificationService.sendPushToUser(reportOwnerId, {
            title: 'Settlement completed',
            body: description,
            data: { type: 'SETTLEMENT_DONE', reportId, reportName },
          });
        }
      } catch (notifErr: any) {
        logger.warn({ err: notifErr?.message ?? notifErr, reportId }, 'Settlement notification failed');
      }

      return report;
    } catch (error) {
      await session.abortTransaction();
      logger.error({ error, reportId, adminId }, 'Error processing settlement');
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Get settlement information for a report
   * Calculates employee paid amount and voucher totals
   */
  static async getSettlementInfo(reportId: string): Promise<{
    reportId: string;
    totalAmount: number;
    voucherTotalUsed: number;
    employeePaidAmount: number;
    currency: string;
    appliedVouchers: Array<{
      voucherId: string;
      voucherCode: string;
      amountUsed: number;
      currency: string;
    }>;
    settlementStatus?: string;
    settlementDecision?: any;
  }> {
    if (!mongoose.Types.ObjectId.isValid(reportId)) {
      throw new Error('Invalid report ID');
    }

    const report = await ExpenseReport.findById(reportId)
      .populate('appliedVouchers.voucherId', 'voucherCode')
      .exec();

    if (!report) {
      throw new Error('Report not found');
    }

    const appliedVouchers = Array.isArray(report.appliedVouchers) ? report.appliedVouchers : [];
    const voucherTotalUsed = appliedVouchers.reduce((sum, v) => sum + (v.amountUsed || 0), 0);
    const employeePaidAmount = Math.max(0, (report.totalAmount || 0) - voucherTotalUsed);

    return {
      reportId,
      totalAmount: report.totalAmount || 0,
      voucherTotalUsed,
      employeePaidAmount,
      currency: report.currency || 'INR',
      appliedVouchers: appliedVouchers.map((v) => ({
        voucherId: (v.voucherId as mongoose.Types.ObjectId).toString(),
        voucherCode: v.voucherCode,
        amountUsed: v.amountUsed,
        currency: v.currency,
      })),
      settlementStatus: report.settlementStatus,
      settlementDecision: report.settlementDecision,
    };
  }
}


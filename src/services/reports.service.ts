import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import {
  ExpenseReport,
  IExpenseReport,
  IApprover,
} from '../models/ExpenseReport';
import { User } from '../models/User';
import { Project } from '../models/Project';
import { CostCentre } from '../models/CostCentre';
import { ApprovalRule, ApprovalRuleTriggerType, ApprovalRuleApproverRole } from '../models/ApprovalRule';
import { emitCompanyAdminDashboardUpdate, emitManagerReportUpdate, emitManagerDashboardUpdate } from '../socket/realtimeEvents';
import { CreateReportDto, UpdateReportDto, ReportFiltersDto } from '../utils/dtoTypes';
import { ExpenseReportStatus, UserRole, ExpenseStatus , AuditAction } from '../utils/enums';
import { getPaginationOptions, createPaginatedResult } from '../utils/pagination';

import { AuditService } from './audit.service';
import { CompanyAdminDashboardService } from './companyAdminDashboard.service';
import { NotificationService } from './notification.service';

import { logger } from '@/config/logger';

export class ReportsService {
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

      const report = new ExpenseReport({
        userId,
        projectId,
        projectName: data.projectName?.trim() || undefined,
        costCentreId,
        name: data.name,
        notes: data.notes,
        fromDate: new Date(data.fromDate),
        toDate: new Date(data.toDate),
        status: ExpenseReportStatus.DRAFT,
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

      // Emit company admin dashboard update if user has a company
      try {
        const user = await User.findById(userId).select('companyId').exec();
        if (user && user.companyId) {
          const companyId = user.companyId.toString();
          const stats = await CompanyAdminDashboardService.getDashboardStatsForCompany(companyId);
          emitCompanyAdminDashboardUpdate(companyId, stats);
        }
      } catch (error) {
        // Don't fail report creation if dashboard update fails
        logger.error({ error }, 'Error emitting company admin dashboard update');
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
    // Ensure userId is converted to ObjectId for proper matching
    const query: any = { userId: new mongoose.Types.ObjectId(userId) };

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
    } else if (requestingUserRole === 'ADMIN' || requestingUserRole === 'BUSINESS_HEAD' || requestingUserRole === 'SUPER_ADMIN') {
      // Admins and business heads have access
      hasAccess = true;
    } else if (requestingUserRole === 'COMPANY_ADMIN') {
      // Company admin: check if report user belongs to their company
      try {
        const { CompanyAdmin } = await import('../models/CompanyAdmin');
        const { User } = await import('../models/User');
        
        // Get company admin's company ID
        const companyAdmin = await CompanyAdmin.findById(requestingUserIdStr).select('companyId').exec();
        if (companyAdmin && companyAdmin.companyId) {
          // Get report user's company ID
          const reportUser = await User.findById(reportUserId).select('companyId').exec();
          if (reportUser && reportUser.companyId) {
            // Check if both belong to the same company
            const companyAdminCompanyId = companyAdmin.companyId.toString();
            const reportUserCompanyId = reportUser.companyId.toString();
            if (companyAdminCompanyId === reportUserCompanyId) {
              hasAccess = true;
            }
          }
        }
      } catch (error) {
        logger.error({ error }, 'Error checking company admin access');
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
        if (expenseObj.receiptPrimaryId && expenseObj.receiptPrimaryId.storageKey) {
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
        return expenseObj;
      })
    );

    // Convert to plain object and add expenses
    const reportObj = report.toObject();
    return {
      ...reportObj,
      expenses: expensesWithSignedUrls,
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

  static async computeApproverChain(report: IExpenseReport): Promise<IApprover[]> {
    const approvers: IApprover[] = [];
    const reportUser = await User.findById(report.userId);
    
    if (!reportUser) {
      throw new Error('Report owner not found');
    }

    // STEP 1: Build normal hierarchy-based approval chain
    // Level 1: Manager (if employee has a manager)
    if (reportUser.managerId) {
      const manager = await User.findById(reportUser.managerId);
      if (manager && manager.status === 'ACTIVE') {
        approvers.push({
          level: 1,
          userId: manager._id as mongoose.Types.ObjectId,
          role: manager.role,
        });
      }
    }

    // Level 2: Business Head (if manager exists and has a business head, or if user is manager and has BH)
    if (approvers.length > 0) {
      const manager = await User.findById(approvers[0].userId);
      if (manager && manager.managerId) {
        const businessHead = await User.findById(manager.managerId);
        if (businessHead && businessHead.status === 'ACTIVE' && 
            (businessHead.role === UserRole.BUSINESS_HEAD || businessHead.role === UserRole.ADMIN)) {
          approvers.push({
            level: 2,
            userId: businessHead._id as mongoose.Types.ObjectId,
            role: businessHead.role,
          });
        }
      }
    } else {
      // If no manager, check if user's manager is a business head
      if (reportUser.managerId) {
        const potentialBH = await User.findById(reportUser.managerId);
        if (potentialBH && potentialBH.status === 'ACTIVE' && 
            (potentialBH.role === UserRole.BUSINESS_HEAD || potentialBH.role === UserRole.ADMIN)) {
          approvers.push({
            level: 1,
            userId: potentialBH._id as mongoose.Types.ObjectId,
            role: potentialBH.role,
          });
        }
      }
    }

    // If no approvers found, assign to ADMIN or COMPANY_ADMIN as fallback
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

    // STEP 2: Evaluate additional approval rules and inject approvers if conditions match
    if (reportUser.companyId) {
      const additionalApprovers = await this.evaluateAdditionalApprovalRules(report, reportUser.companyId);
      
      // Insert additional approvers after the last normal approver
      // They should be at a level higher than the highest existing level
      const maxLevel = approvers.length > 0 ? Math.max(...approvers.map(a => a.level)) : 0;
      
      additionalApprovers.forEach((additionalApprover, index) => {
        approvers.push({
          ...additionalApprover,
          level: maxLevel + index + 1, // Ensure additional approvals come after normal approvals
        });
      });
    }

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

        // If rule should trigger, find an approver with the specified role
        if (shouldTrigger) {
          const approver = await this.findAdditionalApprover(
            companyId,
            rule.approverRole
          );

          if (approver) {
            // Check if this approver is already in the chain to avoid duplicates
            const isDuplicate = additionalApprovers.some(
              a => a.userId.toString() === approver._id.toString()
            );

            if (!isDuplicate) {
              additionalApprovers.push({
                level: 0, // Will be set correctly in computeApproverChain
                userId: approver._id as mongoose.Types.ObjectId,
                role: approver.role,
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
   */
  static async findAdditionalApprover(
    companyId: mongoose.Types.ObjectId,
    approverRole: ApprovalRuleApproverRole
  ): Promise<any> {
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

  static async submitReport(id: string, userId: string): Promise<IExpenseReport> {
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

    // Compute approver chain
    const approvers = await this.computeApproverChain(report);
    if (approvers.length === 0) {
      throw new Error('No approvers found for this report');
    }

    report.status = ExpenseReportStatus.SUBMITTED;
    report.submittedAt = new Date();
    report.updatedBy = new mongoose.Types.ObjectId(userId);
    report.approvers = approvers;

    const saved = await report.save();

    await AuditService.log(
      userId,
      'ExpenseReport',
      id,
      AuditAction.STATUS_CHANGE,
      { status: ExpenseReportStatus.SUBMITTED, approvers: approvers.map(a => ({ level: a.level, userId: a.userId.toString() })) }
    );

    // Notify approvers
    await NotificationService.notifyReportSubmitted(saved);

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

    return saved;
  }

  static async handleReportAction(
    id: string,
    userId: string,
    action: 'approve' | 'reject' | 'request_changes',
    comment?: string
  ): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(id);

    if (!report) {
      throw new Error('Report not found');
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
    } else if (action === 'approve') {
      // Check if this is the last approver
      const totalLevels = Math.max(...report.approvers.map(a => a.level));
      if (currentLevel >= totalLevels) {
        // Final approval
        report.status = ExpenseReportStatus.APPROVED;
        report.approvedAt = new Date();
      } else {
        // Move to next level
        if (currentLevel === 1) {
          report.status = ExpenseReportStatus.MANAGER_APPROVED;
        } else if (currentLevel === 2) {
          report.status = ExpenseReportStatus.BH_APPROVED;
        }
      }
    } else if (action === 'request_changes') {
      // Revert to DRAFT for changes
      report.status = ExpenseReportStatus.DRAFT;
    }

    report.updatedBy = new mongoose.Types.ObjectId(userId);
    const saved = await report.save();

    await AuditService.log(
      userId,
      'ExpenseReport',
      id,
      AuditAction.STATUS_CHANGE,
      { action, comment, level: currentLevel, newStatus: saved.status }
    );

    // Notify report owner
    if (saved.status === ExpenseReportStatus.APPROVED || saved.status === ExpenseReportStatus.REJECTED) {
      await NotificationService.notifyReportStatusChanged(saved, saved.status);
    }

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
    }

    await AuditService.log(
      adminUserId,
      'ExpenseReport',
      id,
      AuditAction.STATUS_CHANGE,
      { status: newStatus }
    );

    // Emit company admin dashboard update if report user has a company
    try {
      const reportUser = await User.findById(saved.userId).select('companyId').exec();
      if (reportUser && reportUser.companyId) {
        const companyId = reportUser.companyId.toString();
        const stats = await CompanyAdminDashboardService.getDashboardStatsForCompany(companyId);
        emitCompanyAdminDashboardUpdate(companyId, stats);
      }
    } catch (error) {
      // Don't fail report update if dashboard update fails
      logger.error({ error }, 'Error emitting company admin dashboard update');
    }

    // Notify employee
    await NotificationService.notifyReportStatusChanged(saved, newStatus);

    return saved;
  }

  static async recalcTotals(reportId: string): Promise<void> {
    const expenses = await Expense.find({ reportId });
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

    // Emit socket events
    try {
      if (user && user.companyId) {
        const companyId = user.companyId.toString();
        const stats = await CompanyAdminDashboardService.getDashboardStatsForCompany(companyId);
        emitCompanyAdminDashboardUpdate(companyId, stats);
      }
    } catch (error) {
      // Don't fail deletion if real-time updates fail
      logger.error({ error }, 'Error emitting company admin dashboard update after report deletion');
    }

    emitManagerDashboardUpdate(reportUserId);
  }
}


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
import { emitCompanyAdminDashboardUpdate, emitManagerReportUpdate, emitManagerDashboardUpdate } from '../socket/realtimeEvents';
import { buildCompanyQuery } from '../utils/companyAccess';
import { CreateReportDto, UpdateReportDto, ReportFiltersDto } from '../utils/dtoTypes';
import { ExpenseReportStatus, UserRole, ExpenseStatus, AuditAction } from '../utils/enums';
import { getPaginationOptions, createPaginatedResult } from '../utils/pagination';

import { ApprovalService } from './ApprovalService';
import { AuditService } from './audit.service';
import { BusinessHeadSelectionService } from './businessHeadSelection.service';
import { CompanyAdminDashboardService } from './companyAdminDashboard.service';
import { DuplicateInvoiceService } from './duplicateInvoice.service';
import { NotificationService } from './notification.service';

import { logger } from '@/config/logger';

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

      const fromDate = new Date(data.fromDate);
      const toDate = new Date(data.toDate);
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
    
    // Debug logging for pagination
    console.log(`[ReportsService] Pagination: page=${page}, pageSize=${pageSize}, skip=${(page - 1) * pageSize}`);
    
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

    console.log(`[ReportsService] Query result: ${reports.length} reports returned (total: ${total}, requested: ${pageSize})`);

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
            const roles = await Role.find({ _id: { $in: roleIds } }).select('name').exec();
            const roleNames = roles.map(r => r.name);
            
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
            
            // Determine step name
            let stepName = `Level ${level.levelNumber} Approval`;
            if (level.levelNumber === 1) {
              stepName = 'Manager Approval';
            } else if (level.levelNumber === 2) {
              stepName = 'Business Head Approval';
            }
            
            // Map action to frontend expected format
            let mappedAction = null;
            if (action === 'approved') mappedAction = 'approve';
            else if (action === 'rejected') mappedAction = 'reject';
            else if (action === 'changes_requested') mappedAction = 'request_changes';
            
            approvalChain.push({
              level: level.levelNumber,
              step: stepName,
              role: roleNames.join(', ') || 'Approver',
              roleIds: roleIds,
              name: approverName, // Frontend expects 'name'
              approverName: approverName, // Also include for compatibility
              approverId: approverId,
              userId: approverId ? { name: approverName } : null, // Frontend may check userId.name
              decidedAt: decidedAt,
              comment: comment, // Frontend expects 'comment'
              action: mappedAction, // Frontend expects 'approve', 'reject', 'request_changes'
              isAdditionalApproval: false
            });
          }
        }
      }
    } catch (error) {
      logger.error({ error, reportId: id }, 'Error fetching approval chain');
      // Continue without approval chain if there's an error
    }

    // Convert to plain object and add expenses and approval chain
    const reportObj = report.toObject();
    return {
      ...reportObj,
      expenses: expensesWithSignedUrls,
      approvers: approvalChain.length > 0 ? approvalChain : reportObj.approvers || [],
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
    if (reportUser.companyId) {
      const additionalApprovers = await this.evaluateAdditionalApprovalRules(report, reportUser.companyId);

      // Insert additional approvers after the last normal approver
      const maxLevel = approvers.length > 0 ? Math.max(...approvers.map(a => a.level)) : 0;

      additionalApprovers.forEach((additionalApprover, index) => {
        approvers.push({
          ...additionalApprover,
          level: maxLevel + index + 1, // Ensure additional approvals come after normal approvals
        });
      });
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

    // Check for duplicate invoices
    const reportUser = await User.findById(report.userId).select('companyId').exec();
    if (reportUser && reportUser.companyId) {
      const duplicates = await DuplicateInvoiceService.checkReportDuplicates(
        id,
        reportUser.companyId
      );

      if (duplicates.length > 0) {
        const duplicateMessages = duplicates.map(d => d.message).join('; ');
        throw new Error(`Duplicate invoices detected: ${duplicateMessages}`);
      }
    }

    // Track approvers for audit/logging without relying on a scoped variable
    let approvalInstanceIdForAudit: string | undefined;

    // Use the NEW Approval Matrix System
    if (reportUser && reportUser.companyId) {
      try {
        // Initiate approval using the ApprovalService (Matrix-based)
        const approvalInstance = await ApprovalService.initiateApproval(
          reportUser.companyId.toString(),
          id,
          'EXPENSE_REPORT',
          report
        );
        approvalInstanceIdForAudit = (approvalInstance._id as any)?.toString?.() || String(approvalInstance._id);

        logger.info({
          reportId: id,
          userId,
          approvalInstanceId: approvalInstance._id,
          currentLevel: approvalInstance.currentLevel,
          status: approvalInstance.status
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

        // Clear the old approvers array since we're using ApprovalInstance now
        report.approvers = [];

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

        await NotificationService.notifyReportSubmitted(reportForNotification);
        logger.info({ reportId: saved._id }, 'Notifications sent successfully');
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

    return saved;
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
      baseQuery.userId = filters.userId;
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


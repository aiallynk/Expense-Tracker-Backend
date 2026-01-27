import mongoose from 'mongoose';

import { ApprovalInstance, IApprovalInstance, ApprovalStatus } from '../models/ApprovalInstance';
import { ApprovalMatrix, IApprovalMatrix, IApprovalLevel, ApprovalType, ParallelRule } from '../models/ApprovalMatrix';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { AuditAction, ExpenseReportStatus } from '../utils/enums';

import { logger } from '@/config/logger';
import { AuditService } from './audit.service';
import { config } from '@/config/index';
import { DateUtils } from '../utils/dateUtils';
// NOTE: Keep ApprovalService fully functional for matrix-based approvals.
// Employee-level chains can be integrated later without breaking ApprovalInstance flow.

export class ApprovalService {
    /**
   * Initiates approval for an Expense Report using the active Approval Matrix.
   * This MUST create an ApprovalInstance, otherwise pending approvals will never show.
     */
    static async initiateApproval(
        companyId: string,
        requestId: string,
        requestType: 'EXPENSE_REPORT',
        initialData?: any
    ): Promise<IApprovalInstance> {
        const matrix = await ApprovalMatrix.findOne({ companyId, isActive: true }).exec();
        if (!matrix) {
      logger.warn({ companyId, requestId }, 'No active approval matrix found.');
            throw new Error('No active approval matrix configuration found for this company.');
        }

        let requestData = initialData;
        if (!requestData && requestType === 'EXPENSE_REPORT') {
            requestData = await ExpenseReport.findById(requestId).exec();
        }
        if (!requestData) {
            throw new Error('Request data not found for approval initiation.');
        }

        const submitterId = (requestData.userId?.toString?.() ?? requestData.userId) as string;
        const { CompanySettings } = await import('../models/CompanySettings');
        const companySettings = await CompanySettings.findOne({ companyId }).lean().exec();
        const selfApprovalPolicy = (companySettings as any)?.selfApprovalPolicy ?? 'SKIP_SELF';

        const instance = new ApprovalInstance({
            companyId,
            matrixId: matrix._id,
            requestId,
            requestType,
            currentLevel: 1,
            status: ApprovalStatus.PENDING,
      history: [],
    });

        if (selfApprovalPolicy === 'ALLOW_SELF') {
      const nextState = await this.evaluateLevel(instance as any, matrix as any, 1, requestData);
      instance.currentLevel = nextState.levelNumber;
      instance.status = nextState.status;
        } else {
      // SKIP_SELF: skip levels where submitter is an approver; auto-approve if submitter is last
      const levels = ((matrix as any).levels || []).filter((l: any) => l.enabled !== false);
      const sortedLevels = [...levels].sort((a: any, b: any) => a.levelNumber - b.levelNumber);
      const history: any[] = [];
      let firstNonSubmitterLevel: any = null;
      for (const level of sortedLevels) {
        const approverIds = await this.getApproverUserIdsForLevel(level, companyId);
        const normalizedApproverIds = new Set(approverIds.map((id) => id.toString().toLowerCase().trim()));
        const submitterNorm = submitterId.toString().toLowerCase().trim();
        if (normalizedApproverIds.has(submitterNorm)) {
          history.push({
            levelNumber: level.levelNumber,
            status: ApprovalStatus.SKIPPED,
            timestamp: new Date(),
            comments: 'Self approval skipped per company policy',
          });
          await AuditService.log(submitterId, 'ExpenseReport', requestId, AuditAction.SELF_APPROVAL_SKIPPED, {
            reportId: requestId,
            userId: submitterId,
            policy: 'SKIP_SELF',
            level: level.levelNumber,
          });
        } else {
          firstNonSubmitterLevel = level;
          break;
        }
      }
      if (!firstNonSubmitterLevel) {
        instance.status = ApprovalStatus.APPROVED;
        instance.history = history;
        await instance.save();
        const approvalMeta = {
          type: 'AUTO_APPROVED' as const,
          reason: 'SUBMITTER_IS_LAST_APPROVER',
          policy: 'SKIP_SELF',
          approvedAt: new Date(),
        };
        await this.finalizeApproval(instance, approvalMeta);
        await AuditService.log(submitterId, 'ExpenseReport', requestId, AuditAction.AUTO_APPROVED, {
          reportId: requestId,
          reason: 'SUBMITTER_IS_LAST_APPROVER',
          policy: 'SKIP_SELF',
        });
        await this.notifyStatusChange(instance, 'APPROVED');
        return instance;
      }
      instance.currentLevel = firstNonSubmitterLevel.levelNumber;
      instance.status = ApprovalStatus.PENDING;
      instance.history = history;
        }

        await instance.save();
        await this.syncRequestStatus(instance);

        if (instance.status === ApprovalStatus.PENDING) {
            await this.notifyApprovers(instance, matrix);
    } else if (instance.status === ApprovalStatus.APPROVED) {
      await this.finalizeApproval(instance);
      await this.notifyStatusChange(instance, 'APPROVED');
        }

        return instance;
    }

    /** Resolve approver user IDs for a matrix level (for self-approval skip logic). */
    private static async getApproverUserIdsForLevel(level: any, companyId: string): Promise<string[]> {
      if (level.approverUserIds && level.approverUserIds.length > 0) {
        return level.approverUserIds.map((id: any) => (id._id ?? id).toString()).filter(Boolean);
      }
      if (level.approverRoleIds && level.approverRoleIds.length > 0) {
        const roleIds = level.approverRoleIds.map((id: any) => (id._id ?? id)).filter(Boolean);
        const userIds = await User.find({
          companyId: new mongoose.Types.ObjectId(companyId),
          roles: { $in: roleIds },
        })
          .select('_id')
          .lean()
          .exec();
        return userIds.map((u: any) => u._id.toString());
      }
      return [];
    }

    /**
   * Defensive: Get all pending approvals for a user based on their roles.
   * No error can crash the whole query. Bad data just gets logged and skipped.
   */
  static async getPendingApprovalsForUser(userId: string, options: { page?: number; limit?: number; startDate?: string; endDate?: string } = {}): Promise<{ data: any[]; total: number }> {
    try {
        const user = await User.findById(userId).populate('roles').exec();
      if (!user) {
        logger.warn({ userId }, 'User not found in getPendingApprovalsForUser');
        return { data: [], total: 0 };
      }
      
      if (!user.roles || user.roles.length === 0) {
        logger.warn({ userId, companyId: user.companyId }, 'User has no roles assigned in getPendingApprovalsForUser');
        return { data: [], total: 0 };
      }
      
      const userRoleIds: string[] = user.roles.map((r: any) => {
        const roleId = r._id?.toString() || r.toString();
        return roleId;
      }).filter(Boolean);

      if (userRoleIds.length === 0) {
        logger.warn({ userId }, 'User has no valid role IDs after mapping');
        return { data: [], total: 0 };
      }

      // Build query for pending instances with date filters
      const query: any = {
        companyId: user.companyId,
        status: ApprovalStatus.PENDING
      };

      if (options.startDate || options.endDate) {
        query.createdAt = {};
        if (options.startDate) query.createdAt.$gte = new Date(options.startDate);
        if (options.endDate) query.createdAt.$lte = new Date(options.endDate);
      }

      // Apply pagination
      const page = options.page || 1;
      const limit = options.limit || 10;
      const skip = (page - 1) * limit;

      // Defensive: catch all errors per-instance so a broken record doesn't break all approvals!
      const pendingInstances = await ApprovalInstance.find(query)
        .populate('matrixId')
        .sort({ createdAt: -1 }) // Most recent first
        .exec();

      logger.info({ 
        userId, 
        userRolesCount: userRoleIds.length, 
        userRoleIds: userRoleIds.slice(0, 5), // Log first 5 for debugging
        pendingInstancesCount: pendingInstances.length, 
        page, 
        limit,
        companyId: user.companyId?.toString()
      }, 'getPendingApprovalsForUser - Start');

      const { CompanySettings } = await import('../models/CompanySettings');
      const companySettingsForPending = user.companyId
        ? await CompanySettings.findOne({ companyId: user.companyId }).lean().exec()
        : null;
      const selfApprovalPolicyForPending = (companySettingsForPending as any)?.selfApprovalPolicy ?? 'SKIP_SELF';

      const pendingForUser: any[] = [];
      for (const instance of pendingInstances) {
        try {
          // Defensive: Ensure matrix is present
          const matrix = instance.matrixId as any;
          if (!matrix) { 
            logger.warn({ instanceId: instance._id }, 'Matrix not found for instance'); 
            continue; 
          }
          
          // CRITICAL: Check if this is an additional approver level BEFORE checking matrix levels
          // Additional approver levels are NOT in the matrix, they're in the report's approvers array
          let isAdditionalApproverLevel = false;
          let isAuthorized = false;
          
          if (instance.requestType === 'EXPENSE_REPORT') {
            const report = await ExpenseReport.findById(instance.requestId)
              .select('approvers')
              .lean()
              .exec();
            
            if (report && report.approvers) {
              const currentAdditionalApprover = (report.approvers as any[]).find(
                (a: any) => a.level === instance.currentLevel && a.isAdditionalApproval === true
              );
              
              if (currentAdditionalApprover) {
                isAdditionalApproverLevel = true;
                // Check if the current user is the assigned additional approver
                const approverUserId = currentAdditionalApprover.userId?.toString() || currentAdditionalApprover.userId;
                const currentUserId = (user._id as mongoose.Types.ObjectId).toString();
                isAuthorized = approverUserId === currentUserId;
                
                logger.info({
                  instanceId: instance._id,
                  reportId: instance.requestId,
                  currentUserId,
                  approverUserId,
                  level: instance.currentLevel,
                  isAuthorized,
                  isAdditionalApproverLevel: true,
                  approverRole: currentAdditionalApprover.role
                }, 'getPendingApprovalsForUser: Checking additional approver authorization');
              }
            }
          }
          
          // If not an additional approver level, check matrix levels
          if (!isAdditionalApproverLevel) {
            const currentLevel = matrix.levels?.find((l: any) => l.levelNumber === instance.currentLevel);
            if (!currentLevel) { 
              logger.warn({ instanceId: instance._id, level: instance.currentLevel, matrixLevels: matrix.levels?.length }, 'Level config not found for instance'); 
              continue; 
            }
            
            // Handle both old format (approverRoleIds) and new format (approverUserIds)
            let approverIds = [];
            let isUserBasedApproval = false;

            if (currentLevel.approverUserIds && currentLevel.approverUserIds.length > 0) {
              // New format: specific users
              approverIds = currentLevel.approverUserIds.map((id: any) => id._id?.toString() || id.toString()).filter(Boolean);
              isUserBasedApproval = true;
            } else if (currentLevel.approverRoleIds && currentLevel.approverRoleIds.length > 0) {
              // Old format: roles (for backward compatibility)
              approverIds = currentLevel.approverRoleIds.map((id: any) => id._id?.toString() || id.toString()).filter(Boolean);
              isUserBasedApproval = false;
            }
            
            if (approverIds.length === 0) {
              logger.warn({ instanceId: instance._id, level: instance.currentLevel }, 'No approver IDs found for current level');
              continue;
            }

            // Check if user is authorized for this level
            if (isUserBasedApproval) {
              // New format: check if user ID is directly in the approver list
              const normalizedApproverIds = approverIds.map((id: string) => id.toLowerCase().trim());
              const userId = (user._id as mongoose.Types.ObjectId).toString().toLowerCase().trim();
              isAuthorized = normalizedApproverIds.includes(userId);
            } else {
              // Old format: check if user has matching role
              const normalizedApproverRoleIds = approverIds.map((id: string) => id.toLowerCase().trim());
              const normalizedUserRoleIds = userRoleIds.map((id: string) => id.toLowerCase().trim());

              const matchingRoleId = normalizedApproverRoleIds.find((rId: string) =>
                normalizedUserRoleIds.includes(rId)
              );
              isAuthorized = !!matchingRoleId;
            }
          }

          // Only actionable for *current* level approvers:
          if (!isAuthorized) {
            logger.debug({
              instanceId: instance._id,
              userId: user._id,
              level: instance.currentLevel,
              isAdditionalApproverLevel
            }, 'User is not authorized for this approval level');
            continue;
          }
          
          // Parallel ALL/ANY: if this user already acted at this level, don't show it again
          const currentUserId = (user._id as mongoose.Types.ObjectId).toString();
          const alreadyActed = instance.history?.some(
            (h: any) =>
              h.levelNumber === instance.currentLevel &&
              h.approverId?.toString?.() === currentUserId
          );
          if (alreadyActed) {
            logger.debug({ instanceId: instance._id, userId: currentUserId }, 'User already acted on this approval');
            continue;
          }
          // Fetch details for this report
          let requestDetails: any = null;
            if (instance.requestType === 'EXPENSE_REPORT') {
            requestDetails = await ExpenseReport.findById(instance.requestId)
              .select('name totalAmount fromDate toDate status userId notes createdAt projectId costCentreId appliedVouchers approvers currency companyId approvalMeta')
              .populate('userId', 'name email companyId')
              .populate('projectId', 'name code')
              .lean()
              .exec();
              
            // If report doesn't have additional approvers but should (based on rules), check rules dynamically
            // This handles reports submitted before the fix was applied
            if (requestDetails && requestDetails.userId) {
              const userIdObj = requestDetails.userId as any;
              let companyId = userIdObj.companyId;
              
              // If companyId not populated, fetch it from User model
              if (!companyId && userIdObj._id) {
                const user = await User.findById(userIdObj._id).select('companyId').lean().exec();
                companyId = user?.companyId;
              }
              
              const hasAdditionalApprovers = requestDetails.approvers?.some((a: any) => a.isAdditionalApproval === true);
              
              if (!hasAdditionalApprovers && companyId) {
                // Re-evaluate approval rules to check if additional approvers should exist
                try {
                  const { ReportsService } = await import('./reports.service');
                  
                  // Create a temporary report object for rule evaluation
                  const tempReport = {
                    _id: requestDetails._id,
                    totalAmount: requestDetails.totalAmount,
                    projectId: requestDetails.projectId,
                    costCentreId: requestDetails.costCentreId,
                    userId: userIdObj._id || userIdObj,
                  };
                  const additionalApprovers = await ReportsService.evaluateAdditionalApprovalRules(
                    tempReport as any,
                    new mongoose.Types.ObjectId(companyId)
                  );
                  
                  // If additional approvers should exist, add them to requestDetails for UI display
                  if (additionalApprovers.length > 0) {
                    if (!requestDetails.approvers) {
                      requestDetails.approvers = [];
                    }
                    
                    // Get max level from ApprovalMatrix
                    const { ApprovalMatrix } = await import('../models/ApprovalMatrix');
                    const matrix = await ApprovalMatrix.findOne({ 
                      companyId: companyId, 
                      isActive: true 
                    }).exec();
                    
                    let maxLevel = 2;
                    if (matrix && matrix.levels) {
                      const enabledLevels = matrix.levels
                        .filter((l: any) => l.enabled !== false)
                        .map((l: any) => l.levelNumber);
                      if (enabledLevels.length > 0) {
                        maxLevel = Math.max(...enabledLevels);
                      }
                    }
                    
                    const insertAfterLevel = Math.max(maxLevel, 2);
                    additionalApprovers.forEach((approver, index) => {
                      requestDetails.approvers.push({
                        ...approver,
                        level: insertAfterLevel + index + 1,
                      });
                    });
                    
                    logger.info({
                      reportId: instance.requestId,
                      additionalApproversCount: additionalApprovers.length,
                      message: 'Additional approvers computed dynamically for existing report'
                    }, 'ApprovalService: Dynamic additional approver evaluation');
                  }
                } catch (ruleError) {
                  logger.warn({ error: ruleError, reportId: instance.requestId }, 
                    'Failed to evaluate additional approval rules dynamically');
                  // Continue without additional approvers if evaluation fails
                }
              }
            }
          }
          if (!requestDetails) continue;
          
          // FORENSIC STEP 1: Database verification query - verify expenseDate exists in DB
          const dbCheck = await Expense.findOne({ reportId: instance.requestId })
            .select('_id expenseDate')
            .lean()
            .exec();
          
          if (dbCheck) {
            logger.debug({
              reportId: instance.requestId,
              expenseId: dbCheck._id,
              hasExpenseDate: !!dbCheck.expenseDate,
              expenseDateType: dbCheck.expenseDate ? typeof dbCheck.expenseDate : 'missing',
              expenseDateValue: dbCheck.expenseDate,
              expenseDateIsDate: dbCheck.expenseDate instanceof Date
            }, 'FORENSIC: Direct DB check for expenseDate');
          }
          
          // FORENSIC STEP 2: Before expense query - log reportId and query parameters
          logger.debug({
            reportId: instance.requestId,
            requestType: instance.requestType,
            instanceId: instance._id
          }, 'FORENSIC: About to fetch expenses for approval');
          
          // CRITICAL: Fetch expenses with all fields (expenseDate is required in schema)
          // Using .lean() returns plain objects with all fields by default (including duplicateFlag, needsReview, etc.)
          const expenses = await Expense.find({ reportId: instance.requestId })
            .populate('categoryId', 'name')
            .populate('receiptPrimaryId', '_id storageUrl mimeType filename')
            .populate('receiptIds', '_id storageUrl mimeType filename')
            .lean()
            .exec();
          
          // FORENSIC STEP 3: After expense query - log raw expense objects from database
          if (expenses.length > 0) {
            const firstExpense = expenses[0];
            logger.debug({ 
              reportId: instance.requestId, 
              expensesCount: expenses.length,
              expensesWithDate: expenses.filter(e => e.expenseDate).length,
              rawExpenseFromDB: {
                id: firstExpense._id,
                hasExpenseDate: !!firstExpense.expenseDate,
                expenseDateType: firstExpense.expenseDate ? typeof firstExpense.expenseDate : 'missing',
                expenseDateValue: firstExpense.expenseDate,
                expenseDateIsDate: firstExpense.expenseDate instanceof Date,
                hasInvoiceDate: !!firstExpense.invoiceDate,
                invoiceDateType: firstExpense.invoiceDate ? typeof firstExpense.invoiceDate : 'missing',
                hasCreatedAt: !!firstExpense.createdAt,
                createdAtType: firstExpense.createdAt ? typeof firstExpense.createdAt : 'missing',
                hasUpdatedAt: !!firstExpense.updatedAt,
                updatedAtType: firstExpense.updatedAt ? typeof firstExpense.updatedAt : 'missing',
                allKeys: Object.keys(firstExpense || {})
              }
            }, 'FORENSIC: Raw expenses from database (after .lean())');
          } else {
            logger.warn({ reportId: instance.requestId }, 'FORENSIC: No expenses found for report in approval');
          }
          // FORENSIC STEP 4: Map expenses with corrected logic to preserve expenseDate
          // BUG ROOT CAUSE: The previous code set expenseDate: expenseDate where expenseDate could be undefined,
          // which would overwrite the valid exp.expenseDate from the spread operator with undefined.
          // FIX: Preserve original value first, only override if we have a valid converted value.
          const mappedExpenses = expenses.map((exp: any) => {
            // CRITICAL: Preserve original values first to ensure dates are never lost
            // This matches the logic in ExpensesService.getExpenseById for consistency
            let expenseDate: string | Date | undefined = exp.expenseDate;
            let invoiceDate: string | Date | undefined = exp.invoiceDate;
            
            // Convert Date objects to YYYY-MM-DD strings (consistent with user flow)
            // Using DateUtils.backendDateToFrontend ensures consistency with ExpensesService
            if (exp.expenseDate instanceof Date) {
              expenseDate = DateUtils.backendDateToFrontend(exp.expenseDate);
            } else if (exp.expenseDate && typeof exp.expenseDate === 'string') {
              // Already a string - could be ISO or YYYY-MM-DD
              // If it's ISO, convert to YYYY-MM-DD for consistency with user flow
              if (exp.expenseDate.includes('T') || exp.expenseDate.includes('Z')) {
                const dateObj = new Date(exp.expenseDate);
                if (!isNaN(dateObj.getTime())) {
                  expenseDate = DateUtils.backendDateToFrontend(dateObj);
                }
              }
              // If already YYYY-MM-DD, keep as is
            }
            
            // Same logic for invoiceDate - preserve original, convert if Date object or ISO string
            if (exp.invoiceDate instanceof Date) {
              invoiceDate = DateUtils.backendDateToFrontend(exp.invoiceDate);
            } else if (exp.invoiceDate && typeof exp.invoiceDate === 'string') {
              // If it's ISO, convert to YYYY-MM-DD for consistency
              if (exp.invoiceDate.includes('T') || exp.invoiceDate.includes('Z')) {
                const dateObj = new Date(exp.invoiceDate);
                if (!isNaN(dateObj.getTime())) {
                  invoiceDate = DateUtils.backendDateToFrontend(dateObj);
                }
              }
              // If already YYYY-MM-DD, keep as is
            }
            
            // createdAt and updatedAt - convert to ISO strings for timestamps
            let createdAt: string | Date | undefined = exp.createdAt;
            if (exp.createdAt instanceof Date) {
              createdAt = exp.createdAt.toISOString();
            } else if (exp.createdAt && typeof exp.createdAt === 'string') {
              createdAt = exp.createdAt;
            }
            
            let updatedAt: string | Date | undefined = exp.updatedAt;
            if (exp.updatedAt instanceof Date) {
              updatedAt = exp.updatedAt.toISOString();
            } else if (exp.updatedAt && typeof exp.updatedAt === 'string') {
              updatedAt = exp.updatedAt;
            }
            
            // CRITICAL: Always include expenseDate and invoiceDate if they exist in original
            // Use converted value if available, otherwise preserve original
            // This ensures dates are never lost even if conversion fails
            return {
              ...exp, // Preserves all original fields (including duplicateFlag, needsReview, etc.)
              receiptUrl: exp.receiptPrimaryId?.storageUrl || null,
              // Always include expenseDate and invoiceDate if they exist in original
              // Use converted value if available, otherwise preserve original from exp
              expenseDate: expenseDate !== undefined ? expenseDate : exp.expenseDate,
              invoiceDate: invoiceDate !== undefined ? invoiceDate : exp.invoiceDate,
              createdAt: createdAt !== undefined ? createdAt : exp.createdAt,
              updatedAt: updatedAt !== undefined ? updatedAt : exp.updatedAt,
              // Preserve duplicate and review flags
              duplicateFlag: exp.duplicateFlag || null,
              duplicateReason: exp.duplicateReason || null,
              needsReview: exp.needsReview || false,
            };
          });
          
          // FORENSIC STEP 5: After mapping - log mapped expense objects
          if (mappedExpenses.length > 0) {
            const firstMapped = mappedExpenses[0];
            logger.debug({
              reportId: instance.requestId,
              mappedExpense: {
                id: firstMapped._id,
                hasExpenseDate: !!firstMapped.expenseDate,
                expenseDateType: firstMapped.expenseDate ? typeof firstMapped.expenseDate : 'missing',
                expenseDateValue: firstMapped.expenseDate,
                hasInvoiceDate: !!firstMapped.invoiceDate,
                invoiceDateType: firstMapped.invoiceDate ? typeof firstMapped.invoiceDate : 'missing',
                hasCreatedAt: !!firstMapped.createdAt,
                createdAtType: firstMapped.createdAt ? typeof firstMapped.createdAt : 'missing',
                hasUpdatedAt: !!firstMapped.updatedAt,
                updatedAtType: firstMapped.updatedAt ? typeof firstMapped.updatedAt : 'missing',
                allKeys: Object.keys(firstMapped || {})
              }
            }, 'FORENSIC: Mapped expenses (after transformation)');
          }
          // FORENSIC STEP 6: Response validation - validate all expenses have expenseDate before returning
          const expensesWithoutDate = mappedExpenses.filter(e => !e.expenseDate);
          if (expensesWithoutDate.length > 0) {
            logger.error({
              reportId: instance.requestId,
              missingCount: expensesWithoutDate.length,
              expenseIds: expensesWithoutDate.map(e => e._id || e.id),
              sampleMissing: expensesWithoutDate[0] ? {
                id: expensesWithoutDate[0]._id,
                allKeys: Object.keys(expensesWithoutDate[0] || {}),
                hasExpenseDate: !!expensesWithoutDate[0].expenseDate,
                expenseDateValue: expensesWithoutDate[0].expenseDate
              } : null
            }, 'FORENSIC ERROR: Expenses missing expenseDate in final response');
          }
          
          // FORENSIC STEP 7: Before response - log final expense objects in response
          if (mappedExpenses.length > 0) {
            const firstFinal = mappedExpenses[0];
            logger.debug({
              reportId: instance.requestId,
              finalExpenseInResponse: {
                id: firstFinal._id,
                hasExpenseDate: !!firstFinal.expenseDate,
                expenseDateType: firstFinal.expenseDate ? typeof firstFinal.expenseDate : 'missing',
                expenseDateValue: firstFinal.expenseDate,
                vendor: firstFinal.vendor,
                amount: firstFinal.amount
              }
            }, 'FORENSIC: Final expense object in response (before returning)');
          }
          
          // Get additional approver info - check if ANY additional approver exists for this report
          // Additional approvers are added after L2, so check all approvers, not just current level
          const additionalApprovers = requestDetails.approvers?.filter(
            (a: any) => a.isAdditionalApproval === true
          ) || [];
          
          // Check if current level is an additional approval level
          const currentApprover = requestDetails.approvers?.find(
            (a: any) => a.level === instance.currentLevel && a.isAdditionalApproval === true
          );
          
          // If current level is additional approval, show info
          // Otherwise, if there are any additional approvers in the chain, show that info too
          const additionalApproverInfo = currentApprover ? {
            isAdditionalApproval: true,
            approverRole: currentApprover.role,
            triggerReason: currentApprover.triggerReason,
            approvalRuleId: currentApprover.approvalRuleId,
            isCurrentLevel: true
          } : (additionalApprovers.length > 0 ? {
            isAdditionalApproval: true,
            approverRole: additionalApprovers[0].role,
            triggerReason: additionalApprovers[0].triggerReason,
            approvalRuleId: additionalApprovers[0].approvalRuleId,
            isCurrentLevel: false,
            pendingLevel: additionalApprovers[0].level
          } : null);

          // Debug logging for vouchers and additional approvers
          logger.debug({
            reportId: instance.requestId,
            hasAppliedVouchers: !!(requestDetails.appliedVouchers && requestDetails.appliedVouchers.length > 0),
            appliedVouchersCount: requestDetails.appliedVouchers?.length || 0,
            hasApprovers: !!(requestDetails.approvers && requestDetails.approvers.length > 0),
            approversCount: requestDetails.approvers?.length || 0,
            additionalApproversCount: additionalApprovers.length,
            hasAdditionalApproverInfo: !!additionalApproverInfo,
            expensesCount: mappedExpenses.length,
            expensesWithDuplicateFlag: mappedExpenses.filter((e: any) => e.duplicateFlag).length,
            expensesWithNeedsReview: mappedExpenses.filter((e: any) => e.needsReview).length,
          }, 'ApprovalService: Report data for approval UI');

          const reportSubmitterId = (requestDetails.userId?._id ?? requestDetails.userId)?.toString?.();
          pendingForUser.push({
            instanceId: instance._id,
            approvalStatus: instance.status,
            currentLevel: instance.currentLevel,
            requestId: instance.requestId,
            requestType: instance.requestType,
            roleName: 'Approver',
            roleId: null,
            data: {
              ...requestDetails,
              id: requestDetails._id,
              reportName: requestDetails.name,
              employeeName: requestDetails.userId?.name,
              employeeEmail: requestDetails.userId?.email,
              projectName: requestDetails.projectId?.name,
              projectCode: requestDetails.projectId?.code,
              // CRITICAL: Always include expenses array (even if empty)
              // Each expense should have expenseDate as ISO string
              expenses: mappedExpenses,
              dateRange: { from: requestDetails.fromDate, to: requestDetails.toDate },
              // Include vouchers for approver visibility
              appliedVouchers: requestDetails.appliedVouchers || [],
              currency: requestDetails.currency || 'INR',
              // Include additional approver info if ANY additional approver exists
              additionalApproverInfo: additionalApproverInfo,
              // Self-approval policy and submitter flag for UX (backend is source of truth)
              selfApprovalPolicy: selfApprovalPolicyForPending,
              isSubmitterCurrentApprover: !!(reportSubmitterId && userId === reportSubmitterId),
              // Include flags for approver visibility (computed from expenses)
              flags: {
                changes_requested: requestDetails.status === 'CHANGES_REQUESTED',
                rejected: requestDetails.status === 'REJECTED',
                voucher_applied: (requestDetails.appliedVouchers || []).length > 0,
                additional_approver_added: additionalApprovers.length > 0,
                duplicate_flagged: mappedExpenses.some(
                  (e: any) => e.duplicateFlag === 'POTENTIAL_DUPLICATE' || e.duplicateFlag === 'STRONG_DUPLICATE' || e.duplicateFlag === 'HARD_DUPLICATE'
                ) || false,
                ocr_needs_review: mappedExpenses.some((e: any) => e.needsReview === true),
              }
            },
            createdAt: instance.createdAt
          });
        } catch (instanceErr) {
          logger.error({ err: instanceErr, instanceId: instance._id }, 'Error fetching single pending approval for user. Skipping instance.');
          continue; // Defensive: keep going
        }
      }
      
      // Apply pagination to filtered results
      const paginatedResults = pendingForUser.slice(skip, skip + limit);
      
      // Pagination logging (only in non-production)
      if (config.app.env !== 'production') {
        logger.debug({ 
          userId, 
          totalFiltered: pendingForUser.length, 
          paginatedCount: paginatedResults.length,
          page,
          limit
        }, 'getPendingApprovalsForUser - Complete');
      }
      
      return { data: paginatedResults, total: pendingForUser.length };
    } catch (err) {
      logger.error({ err, userId }, 'getPendingApprovalsForUser: Fatal error');
      return { data: [], total: 0 };
    }
  }
  // ... any other methods ...

    private static async checkLevelCompletion(instance: IApprovalInstance, levelConfig: IApprovalLevel): Promise<boolean> {
        // Check if this is an additional approver level
        if (instance.requestType === 'EXPENSE_REPORT') {
            const report = await ExpenseReport.findById(instance.requestId).exec();
            if (report) {
                const currentApprover = (report.approvers || []).find(
                    (a: any) => a.level === instance.currentLevel && a.isAdditionalApproval === true
                );
                
                if (currentApprover) {
                    // Additional approver level - only one approver, so sequential approval
                    const approverUserId = currentApprover.userId?.toString() || currentApprover.userId?.toString() || String(currentApprover.userId);
                    const hasApproved = instance.history.some(
                        (h) => {
                          const historyApproverId = h.approverId?.toString();
                          return h.levelNumber === instance.currentLevel && 
                                 h.status === ApprovalStatus.APPROVED &&
                                 historyApproverId === approverUserId;
                        }
                    );
                    return hasApproved;
                }
            }
        }
        
        // Regular matrix level - use existing logic
        if (levelConfig.approvalType === ApprovalType.SEQUENTIAL) return true;

        if (levelConfig.approvalType === ApprovalType.PARALLEL) {
            if (levelConfig.parallelRule === ParallelRule.ANY) return true;
            if (levelConfig.parallelRule === ParallelRule.ALL) {
        // For parallel ALL, check if all required approvers have approved
        const requiredApprovers = levelConfig.approverUserIds || levelConfig.approverRoleIds || [];
        if (requiredApprovers.length === 0) return true;

        const approvedApproverIds = new Set(
          instance.history
            .filter((h) => h.levelNumber === instance.currentLevel && h.status === ApprovalStatus.APPROVED)
            .map((h) => levelConfig.approverUserIds ? h.approverId?.toString() : h.roleId?.toString())
            .filter(Boolean) as string[]
        );

        return approvedApproverIds.size >= requiredApprovers.length;
            }
        }

        return true;
    }

    private static async evaluateLevel(
        instance: IApprovalInstance,
        matrix: IApprovalMatrix,
        levelNumber: number,
        requestData: any
  ): Promise<{ levelNumber: number; status: ApprovalStatus }> {
    const level = matrix.levels.find((l) => l.levelNumber === levelNumber && l.enabled !== false);
        if (!level) {
            return { levelNumber: instance.currentLevel, status: ApprovalStatus.APPROVED };
        }

    // conditions (current engine is permissive; can be extended)
        if (level.conditions && level.conditions.length > 0) {
      const pass = this.evaluateConditions(level.conditions as any[], requestData);
      if (!pass) {
                instance.history.push({
                    levelNumber,
                    status: ApprovalStatus.SKIPPED,
                    timestamp: new Date(),
          comments: 'System: Level skipped based on conditions',
        } as any);
                return this.evaluateLevel(instance, matrix, levelNumber + 1, requestData);
            }
        }

        return { levelNumber, status: ApprovalStatus.PENDING };
    }

    private static evaluateConditions(_conditions: any[], _data: any): boolean {
        return true;
    }

    private static async finalizeApproval(
        instance: IApprovalInstance,
        approvalMeta?: { type: 'AUTO_APPROVED'; reason: string; policy: string; approvedAt: Date }
    ): Promise<void> {
        if (instance.requestType === 'EXPENSE_REPORT') {
            const update: any = {
                status: ExpenseReportStatus.APPROVED,
                approvedAt: new Date(),
            };
            if (approvalMeta) {
                update.approvalMeta = approvalMeta;
            }
            await ExpenseReport.findByIdAndUpdate(instance.requestId, update).exec();

      // Post-approval side-effect: apply advance cash deductions (does not affect approval routing)
      try {
        const { AdvanceCashService } = await import('./advanceCash.service');
        await AdvanceCashService.applyAdvanceForReport(instance.requestId.toString());
      } catch (error) {
        // Surface the error so the caller can react; status is already set, but we prefer visibility.
        logger.error({ error, reportId: instance.requestId }, 'Failed to apply advance cash after approval');
        throw error;
      }
        }
    }

    private static async syncRequestStatus(instance: IApprovalInstance): Promise<void> {
    if (instance.requestType !== 'EXPENSE_REPORT') return;

    let reportStatus = ExpenseReportStatus.SUBMITTED;
            if (instance.status === ApprovalStatus.PENDING) {
                const level = instance.currentLevel;
                // Check if this is an additional approver level
                const report = await ExpenseReport.findById(instance.requestId).exec();
                if (report) {
                  const currentApprover = (report.approvers || []).find(
                    (a: any) => a.level === level && a.isAdditionalApproval === true
                  );
                  
                  if (currentApprover) {
                    // Additional approver level - use highest matrix level status or a generic pending status
                    // Use the last matrix level status (L5, L4, L3, L2, or L1) as fallback
                    const maxMatrixLevel = Math.max(...(report.approvers || [])
                      .filter((a: any) => !a.isAdditionalApproval)
                      .map((a: any) => a.level || 0), 0);
                    
                    if (maxMatrixLevel >= 5) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L5;
                    else if (maxMatrixLevel >= 4) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L4;
                    else if (maxMatrixLevel >= 3) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L3;
                    else if (maxMatrixLevel >= 2) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L2;
                    else reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L1;
                  } else {
                    // Regular matrix level
                    if (level === 1) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L1;
                    else if (level === 2) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L2;
                    else if (level === 3) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L3;
                    else if (level === 4) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L4;
                    else if (level === 5) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L5;
                  }
                } else {
                  // Fallback to regular level mapping
                  if (level === 1) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L1;
                  else if (level === 2) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L2;
                  else if (level === 3) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L3;
                  else if (level === 4) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L4;
                  else if (level === 5) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L5;
                }
            } else if (instance.status === ApprovalStatus.APPROVED) {
                reportStatus = ExpenseReportStatus.APPROVED;
            } else if (instance.status === ApprovalStatus.REJECTED) {
                reportStatus = ExpenseReportStatus.REJECTED;
            } else if (instance.status === ApprovalStatus.CHANGES_REQUESTED) {
                reportStatus = ExpenseReportStatus.CHANGES_REQUESTED;
            }

    await ExpenseReport.findByIdAndUpdate(instance.requestId, { status: reportStatus }).exec();
    }

    private static async notifyApprovers(instance: IApprovalInstance, matrix: IApprovalMatrix): Promise<void> {
        try {
            let requestData: any = null;
            if (instance.requestType === 'EXPENSE_REPORT') {
                requestData = await ExpenseReport.findById(instance.requestId).exec();
            }
            if (!requestData) return;
            
            // Check if current level is an additional approver level
            const report = requestData as any;
            const currentApprover = (report.approvers || []).find(
                (a: any) => a.level === instance.currentLevel && a.isAdditionalApproval === true
            );
            
            if (currentApprover) {
                // This is an additional approver level - notify the specific approver
                const { ApprovalMatrixNotificationService } = await import('./approvalMatrixNotification.service');
                const { NotificationService } = await import('./notification.service');
                
                // Create a mock level config for additional approver
                const additionalLevelConfig = {
                    levelNumber: instance.currentLevel,
                    approverUserIds: [currentApprover.userId.toString()],
                    approverRoleIds: [],
                    enabled: true,
                };
                
                await ApprovalMatrixNotificationService.notifyApprovalRequired(
                    instance, 
                    additionalLevelConfig as any, 
                    requestData
                );
                
                // Also send additional approver notification
                await NotificationService.notifyAdditionalApproverAdded(
                    report,
                    [{
                        userId: currentApprover.userId.toString(),
                        role: currentApprover.role,
                        triggerReason: currentApprover.triggerReason
                    }]
                );
            } else {
                // Regular matrix level - use existing logic
                const currentLevelConfig = matrix.levels.find((l) => l.levelNumber === instance.currentLevel);
                if (!currentLevelConfig) return;
                
                const { ApprovalMatrixNotificationService } = await import('./approvalMatrixNotification.service');
                await ApprovalMatrixNotificationService.notifyApprovalRequired(instance, currentLevelConfig as any, requestData);
            }
        } catch (error: any) {
            logger.error({ error: error?.message || error }, 'Error notifying approvers');
        }
    }

    private static async notifyStatusChange(
        instance: IApprovalInstance,
        status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED',
        comments?: string,
        approvedLevel?: number
    ): Promise<void> {
        try {
      let requestData: any = null;
            if (instance.requestType === 'EXPENSE_REPORT') {
                requestData = await ExpenseReport.findById(instance.requestId).exec();
            }
            if (!requestData) return;

            const { ApprovalMatrixNotificationService } = await import('./approvalMatrixNotification.service');
            await ApprovalMatrixNotificationService.notifyRequestStatusChanged(instance, requestData, status, comments, approvedLevel);
        } catch (error: any) {
      logger.error({ error: error?.message || error }, 'Error notifying status change');
    }
  }


  /**
   * Patch: Approval action is now robust/defensive
   */
  static async processAction(
    instanceId: string,
    userId: string,
    action: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
    comments?: string
  ): Promise<IApprovalInstance> {
    try {
      const instance = await ApprovalInstance.findById(instanceId).exec();
      if (!instance) throw new Error('Approval instance not found');
      if (instance.status !== ApprovalStatus.PENDING) {
        throw new Error(`Approval is already ${instance.status}`);
      }
      const matrix = await ApprovalMatrix.findById(instance.matrixId).exec();
      if (!matrix) throw new Error('Matrix configuration missing');
      // Check if this is an additional approver level (not in matrix)
      let requestData = null;
      if (instance.requestType === 'EXPENSE_REPORT') {
        requestData = await ExpenseReport.findById(instance.requestId).exec();
      }

      // Block self-approval when company policy is SKIP_SELF
      if (action === 'APPROVE' && requestData && instance.requestType === 'EXPENSE_REPORT') {
        const report = requestData as any;
        const reportSubmitterId = (report.userId?.toString?.() ?? report.userId) as string;
        if (reportSubmitterId && userId === reportSubmitterId) {
          const { CompanySettings } = await import('../models/CompanySettings');
          const companySettings = await CompanySettings.findOne({ companyId: instance.companyId }).lean().exec();
          const selfApprovalPolicy = (companySettings as any)?.selfApprovalPolicy ?? 'SKIP_SELF';
          if (selfApprovalPolicy === 'SKIP_SELF') {
            const err: any = new Error('Self approval is not allowed by company policy');
            err.statusCode = 403;
            err.code = 'SELF_APPROVAL_NOT_ALLOWED';
            throw err;
          }
        }
      }
      
      let isAdditionalApproverLevel = false;
      if (requestData) {
        const report = requestData as any;
        const currentApprover = (report.approvers || []).find(
          (a: any) => a.level === instance.currentLevel && a.isAdditionalApproval === true
        );
        isAdditionalApproverLevel = !!currentApprover;
      }
      
      const currentLevelConfig = isAdditionalApproverLevel 
        ? null // Additional approver levels are not in the matrix
        : matrix.levels?.find(l => l.levelNumber === instance.currentLevel);
      
      if (!isAdditionalApproverLevel && !currentLevelConfig) {
        throw new Error('Configuration error: Current level not found');
      }
      // Validate User Permission
      const user = await User.findById(userId).populate('roles').exec();
      if (!user) throw new Error('User not found');
      const userRoleIds = (user.roles || []).map(r => r._id ? r._id.toString() : r.toString());
          // Check if user is authorized for this level
          let isAuthorized = false;
          let authorizedRole = null;
          
          // First, check if this is an additional approver level
          if (isAdditionalApproverLevel && requestData) {
            const report = requestData as any;
            const currentApprover = (report.approvers || []).find(
              (a: any) => a.level === instance.currentLevel && a.isAdditionalApproval === true
            );
            
            if (currentApprover) {
              // This is an additional approver level - check if user matches
              const approverUserId = currentApprover.userId?.toString() || currentApprover.userId;
              isAuthorized = approverUserId === userId;
              if (isAuthorized) {
                // For additional approvers, role is a string (e.g., "CFO"), not an ObjectId
                // We'll store the role name but not convert it to ObjectId
                authorizedRole = currentApprover.role;
              }
            }
          } else if (currentLevelConfig) {
            // Regular matrix level - check matrix configuration
            if (currentLevelConfig.approverUserIds && currentLevelConfig.approverUserIds.length > 0) {
              // New format: check if user ID is directly in the approver list
              const approverUserIds = currentLevelConfig.approverUserIds.map(id => id.toString());
              isAuthorized = approverUserIds.includes(userId);
            } else if (currentLevelConfig.approverRoleIds && currentLevelConfig.approverRoleIds.length > 0) {
              // Old format: check if user has matching role
              authorizedRole = (currentLevelConfig.approverRoleIds || []).find(rId => userRoleIds.includes(rId?.toString()));
              isAuthorized = !!authorizedRole;
            }
          }

      if (!isAuthorized) {
        throw new Error('You are not authorized to approve at this level');
      }
      // Prevent duplicate actions by same user at the same level (important for PARALLEL ALL)
      const alreadyActed = instance.history?.some(
        (h: any) =>
          h.levelNumber === instance.currentLevel &&
          h.approverId?.toString?.() === userId
      );
      if (alreadyActed) {
        throw new Error('You have already taken action at this level');
      }
      // 2. Record the Action
      let historyStatus = ApprovalStatus.APPROVED;
      if (action === 'REJECT') historyStatus = ApprovalStatus.REJECTED;
      if (action === 'REQUEST_CHANGES') historyStatus = ApprovalStatus.CHANGES_REQUESTED;
      
      // For additional approvers, authorizedRole is a string (role name), not an ObjectId
      // Only convert to ObjectId if it's a valid ObjectId string
      let roleIdObjectId: mongoose.Types.ObjectId | undefined = undefined;
      if (authorizedRole) {
        // Check if authorizedRole is a valid ObjectId string (24 hex characters)
        if (mongoose.Types.ObjectId.isValid(authorizedRole) && authorizedRole.length === 24) {
          roleIdObjectId = new mongoose.Types.ObjectId(authorizedRole);
        }
        // If it's not a valid ObjectId (e.g., it's a role name string like "CFO"), leave it undefined
      }
      
      instance.history.push({
        levelNumber: instance.currentLevel,
        status: historyStatus,
        approverId: new mongoose.Types.ObjectId(userId),
        roleId: roleIdObjectId,
        timestamp: new Date(),
        comments
      });
      logger.info(
        { instanceId, userId, action, historyLength: instance.history.length },
        'ApprovalService.processAction: history entry written'
      );
      // 3. Evaluate State Change
      if (action === 'REJECT') {
        instance.status = ApprovalStatus.REJECTED;
        await instance.save();
        if (instance.requestType === 'EXPENSE_REPORT') {
          const reportId = (instance.requestId as mongoose.Types.ObjectId).toString();
          await ExpenseReport.findByIdAndUpdate(instance.requestId, { status: ExpenseReportStatus.REJECTED, rejectedAt: new Date() });
          // Release voucher amount used on this report so it becomes available again
          try {
            const { VoucherService } = await import('./voucher.service');
            await VoucherService.reverseVoucherUsageForReport(
              reportId,
              userId,
              comments || 'Report rejected'
            );
            logger.info({ reportId }, 'ApprovalService: Voucher usages reversed for rejected report');
          } catch (voucherError: any) {
            logger.error(
              { error: voucherError, reportId },
              'ApprovalService: Failed to reverse voucher usages for rejected report'
            );
            // Don't fail report rejection; vouchers may need manual correction
          }
        }
        await ApprovalService.notifyStatusChange(instance, 'REJECTED', comments);
        return instance;
      }
      if (action === 'REQUEST_CHANGES') {
        instance.status = ApprovalStatus.CHANGES_REQUESTED;
        await instance.save();
        if (instance.requestType === 'EXPENSE_REPORT') {
          await ExpenseReport.findByIdAndUpdate(instance.requestId, { status: ExpenseReportStatus.CHANGES_REQUESTED });
        }
        await ApprovalService.notifyStatusChange(instance, 'CHANGES_REQUESTED', comments);
        return instance;
      }
      // Handle APPROVE
      // For additional approver levels, pass a mock config; for matrix levels, use the actual config
      const levelConfigForCheck = isAdditionalApproverLevel 
        ? { approvalType: ApprovalType.SEQUENTIAL } as any
        : currentLevelConfig as any;
      const levelComplete = await this.checkLevelCompletion(instance, levelConfigForCheck);
      if (levelComplete) {
        if (isAdditionalApproverLevel) {
          // This is an additional approver level - check if there are more additional approvers
          if (requestData) {
            const report = requestData as any;
            const remainingAdditionalApprovers = (report.approvers || []).filter(
              (a: any) => a.isAdditionalApproval === true && 
                         a.level > instance.currentLevel && 
                         (!a.decidedAt || !a.action)
            );
            
            if (remainingAdditionalApprovers.length > 0) {
              // Route to next additional approver
              const nextAdditionalApprover = remainingAdditionalApprovers[0];
              instance.currentLevel = nextAdditionalApprover.level;
              instance.status = ApprovalStatus.PENDING;
              
              logger.info({
                reportId: instance.requestId,
                additionalLevel: nextAdditionalApprover.level,
                approverRole: nextAdditionalApprover.role,
                message: 'Routing to next additional approver'
              }, 'ApprovalService: Routing to next additional approver');
            } else {
              // No more additional approvers - finalize approval
              instance.status = ApprovalStatus.APPROVED;
            }
          } else {
            // No request data - finalize approval
            instance.status = ApprovalStatus.APPROVED;
          }
        } else {
          // Regular matrix level - evaluate next level
          const nextLevelNum = instance.currentLevel + 1;
          // Evaluate next level
          const nextState = await ApprovalService.evaluateLevel(instance as any, matrix as any, nextLevelNum, requestData);
          instance.currentLevel = nextState.levelNumber;
          instance.status = nextState.status;
          
          // CRITICAL: If all matrix levels are approved, check for additional approvers
          // Refresh requestData to get the latest approvers array from the database
          if (instance.status === ApprovalStatus.APPROVED && instance.requestType === 'EXPENSE_REPORT') {
            try {
              const freshReport = await ExpenseReport.findById(instance.requestId)
                .select('approvers')
                .lean()
                .exec();
              
              if (freshReport && freshReport.approvers) {
                const approversList = freshReport.approvers as any[];
                const userIdsAlreadyDecided = new Set(
                  approversList
                    .filter((a: any) => a.decidedAt && a.action)
                    .map((a: any) => (a.userId?.toString?.() ?? String(a.userId)))
                );
                const additionalApprovers = approversList.filter(
                  (a: any) =>
                    a.isAdditionalApproval === true &&
                    (!a.decidedAt || !a.action) &&
                    !userIdsAlreadyDecided.has((a.userId?.toString?.() ?? String(a.userId)))
                );
                
                logger.info({
                  reportId: instance.requestId,
                  additionalApproversCount: additionalApprovers.length,
                  approvers: additionalApprovers.map((a: any) => ({
                    level: a.level,
                    role: a.role,
                    userId: a.userId
                  }))
                }, 'processAction: Checking for additional approvers after matrix approval');
                
                if (additionalApprovers.length > 0) {
                  // Route to first additional approver
                  const firstAdditionalApprover = additionalApprovers[0];
                  const additionalLevel = firstAdditionalApprover.level || (nextLevelNum);
                  
                  // Update instance to route to additional approver level
                  instance.currentLevel = additionalLevel;
                  instance.status = ApprovalStatus.PENDING;
                  
                  logger.info({
                    reportId: instance.requestId,
                    additionalLevel,
                    approverRole: firstAdditionalApprover.role,
                    approverUserId: firstAdditionalApprover.userId,
                    message: 'Routing to additional approver after all matrix levels approved'
                  }, 'ApprovalService: Routing to additional approver');
                }
              }
            } catch (error: any) {
              logger.error({
                error: error?.message || error,
                reportId: instance.requestId,
                stack: error?.stack
              }, 'Error checking for additional approvers after matrix approval');
              // Continue - don't fail the approval if we can't check for additional approvers
            }
          }
        }
        
        await instance.save();
        if (instance.status === ApprovalStatus.PENDING) {
          await ApprovalService.syncRequestStatus(instance);
          // Notify requester that their report was approved at the previous level
          const completedLevel = instance.currentLevel > 1 ? instance.currentLevel - 1 : 1;
          await ApprovalService.notifyStatusChange(instance, 'APPROVED', comments, completedLevel);
          // Notify next level approvers (including additional approvers)
          await ApprovalService.notifyApprovers(instance, matrix as any);
        } else if (instance.status === ApprovalStatus.APPROVED) {
          await ApprovalService.finalizeApproval(instance);
          // Determine the level that was just completed (currentLevel - 1, or the last level if no more levels)
          const completedLevel = instance.currentLevel > 1 ? instance.currentLevel - 1 : instance.currentLevel;
          await ApprovalService.notifyStatusChange(instance, 'APPROVED', comments, completedLevel);
        }
        return instance;
      } else {
        await instance.save();
      }
      return instance;
    } catch (error: any) {
      logger.error({ 
        error: error?.message || error, 
        stack: error?.stack,
        instanceId, 
        userId, 
        action 
      }, 'Approval action failed: Defensive catch');
      
      // Re-throw with more context if it's a known error
      if (error?.message) {
        const enhancedError: any = new Error(error.message);
        enhancedError.statusCode = error.statusCode || 500;
        enhancedError.code = error.code || 'APPROVAL_ACTION_FAILED';
        throw enhancedError;
      }
      
      throw new Error('Approval action failed');
    }
  }

  /**
   * Get approval history for a user with filtering.
   * Used for "actions by user" (APPROVED / REJECTED / CHANGES_REQUESTED). Does not default actionType to PENDING.
   * Returns { data: array, pagination: { page, limit, total, pages } }. Controller sends { success: true, data: this } so HTTP response is { success: true, data: { data, pagination } }.
   */
  static async getApprovalHistory(
    filters: any,
    employeeFilter?: string,
    pagination: { page: number; limit: number } = { page: 1, limit: 20 }
  ): Promise<{
    data: any[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      pages: number;
    };
  }> {
    const { page, limit } = pagination;
    const skip = (page - 1) * limit;

    logger.debug(
      { actedBy: filters.actedBy?.toString(), actionType: filters.actionType, page, limit },
      'ApprovalService.getApprovalHistory: start'
    );

    // Build aggregation pipeline
    const pipeline: any[] = [];
    
    // Only add initial match if actedBy is provided and we want to filter by user
    // This pre-filters instances that have at least one history entry by this user
    if (filters.actedBy) {
      pipeline.push({
        $match: {
          'history.approverId': filters.actedBy,
        },
      });
    }
    
    // Unwind history to get individual actions
    // Use preserveNullAndEmptyArrays: false to only keep instances with history
    // But first ensure history array exists and is not empty
    pipeline.push({
      $match: {
        history: { $exists: true, $ne: [], $type: 'array' }
      }
    });
    
    pipeline.push({
      $unwind: {
        path: '$history',
        preserveNullAndEmptyArrays: false, // Only keep instances with history entries
      },
    });
    
    // Filter history entries for this user and action type
    const historyMatch: any = {};
    if (filters.actedBy) {
      historyMatch['history.approverId'] = filters.actedBy;
    }
    if (filters.actionType) {
      historyMatch['history.status'] = filters.actionType;
    }
    if (filters.dateRange) {
      historyMatch['history.timestamp'] = filters.dateRange;
    }
    
    // Only add match stage if we have filters
    if (Object.keys(historyMatch).length > 0) {
      pipeline.push({
        $match: historyMatch,
      });
    }
    
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/4df6bb03-2191-446a-93ae-c093fcd724e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ApprovalService.ts:1090',message:'getApprovalHistory: Adding lookup stages to pipeline',data:{filters,employeeFilter,pipelineLength:pipeline.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    // Push all lookup and transformation stages to pipeline
    pipeline.push(
      // Lookup request details (ExpenseReport)
      {
        $lookup: {
          from: 'expensereports',
          localField: 'requestId',
          foreignField: '_id',
          as: 'requestData',
        },
      },
      {
        $unwind: {
          path: '$requestData',
          preserveNullAndEmptyArrays: true,
        },
      },
      // Apply additional filters
      ...(employeeFilter ? [{
        $match: {
          $or: [
            { 'requestData.employeeName': new RegExp(employeeFilter, 'i') },
            { 'requestData.submittedBy.name': new RegExp(employeeFilter, 'i') },
          ],
        },
      }] : []),
      ...(filters.projectId ? [{
        $match: {
          'requestData.projectId': filters.projectId,
        },
      }] : []),
      ...(filters.costCentreId ? [{
        $match: {
          'requestData.costCentreId': filters.costCentreId,
        },
      }] : []),
      // Lookup project and cost centre details
      {
        $lookup: {
          from: 'projects',
          localField: 'requestData.projectId',
          foreignField: '_id',
          as: 'project',
        },
      },
      {
        $lookup: {
          from: 'costcentres',
          localField: 'requestData.costCentreId',
          foreignField: '_id',
          as: 'costCentre',
        },
      },
      // Lookup user (employee) details
      {
        $lookup: {
          from: 'users',
          localField: 'requestData.userId',
          foreignField: '_id',
          as: 'employee',
        },
      },
      // Lookup expenses for the report with category lookup
      {
        $lookup: {
          from: 'expenses',
          let: { reportId: '$requestData._id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$reportId', '$$reportId'] } } },
            {
              $lookup: {
                from: 'categories',
                localField: 'categoryId',
                foreignField: '_id',
                as: 'category',
              },
            },
            {
              $project: {
                _id: 1,
                vendor: 1,
                notes: 1,
                amount: 1,
                currency: 1,
                expenseDate: 1,
                invoiceDate: 1,
                category: { $arrayElemAt: ['$category.name', 0] },
                categoryId: 1,
                receiptPrimaryId: 1,
                receiptIds: 1,
              },
            },
          ],
          as: 'expenses',
        },
      },
      // Project and format results (use composite _id so frontend has a stable key; history has _id: false)
      {
        $project: {
          _id: { $concat: [{ $toString: '$_id' }, '-', { $toString: '$history.timestamp' }, '-', { $toString: '$history.levelNumber' }] },
          instanceId: '$_id',
          actionType: '$history.status',
          actedAt: '$history.timestamp',
          comments: '$history.comments',
          requestData: {
            id: '$requestData._id',
            name: '$requestData.name',
            reportName: '$requestData.name',
            totalAmount: '$requestData.totalAmount',
            employeeName: {
              $ifNull: [
                { $arrayElemAt: ['$employee.name', 0] },
                'Unknown'
              ]
            },
            // Include vouchers for approver visibility
            appliedVouchers: {
              $ifNull: ['$requestData.appliedVouchers', []]
            },
            currency: {
              $ifNull: ['$requestData.currency', 'INR']
            },
            // Include approvers array to check for additional approvals
            approvers: {
              $ifNull: ['$requestData.approvers', []]
            },
            // Include flags for approver visibility (use $literal so MongoDB does not treat false as exclusion)
            flags: {
              changes_requested: { $eq: ['$requestData.status', 'CHANGES_REQUESTED'] },
              rejected: { $eq: ['$requestData.status', 'REJECTED'] },
              voucher_applied: { $gt: [{ $size: { $ifNull: ['$requestData.appliedVouchers', []] } }, 0] },
              additional_approver_added: {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: { $ifNull: ['$requestData.approvers', []] },
                        as: 'approver',
                        cond: { $eq: ['$$approver.isAdditionalApproval', true] }
                      }
                    }
                  },
                  0
                ]
              },
              duplicate_flagged: { $literal: false },
              ocr_needs_review: { $literal: false }
            },
            projectName: '$requestData.projectName',
            submittedAt: '$requestData.submittedAt',
            createdAt: '$requestData.createdAt',
            expenses: {
              $map: {
                input: '$expenses',
                as: 'exp',
                in: {
                  id: '$$exp._id',
                  vendor: '$$exp.vendor',
                  description: '$$exp.notes',
                  amount: '$$exp.amount',
                  category: '$$exp.category',
                  categoryId: '$$exp.categoryId',
                  currency: '$$exp.currency',
                  expenseDate: '$$exp.expenseDate',
                  invoiceDate: '$$exp.invoiceDate',
                  receiptPrimaryId: '$$exp.receiptPrimaryId',
                  receiptIds: '$$exp.receiptIds',
                }
              }
            },
            items: {
              $map: {
                input: '$expenses',
                as: 'exp',
                in: {
                  id: '$$exp._id',
                  vendor: '$$exp.vendor',
                  description: '$$exp.notes',
                  amount: '$$exp.amount',
                  category: '$$exp.category',
                  categoryId: '$$exp.categoryId',
                  currency: '$$exp.currency',
                  expenseDate: '$$exp.expenseDate',
                  invoiceDate: '$$exp.invoiceDate',
                  receiptPrimaryId: '$$exp.receiptPrimaryId',
                  receiptIds: '$$exp.receiptIds',
                }
              }
            },
          },
          project: {
            $arrayElemAt: ['$project', 0],
          },
          costCentre: {
            $arrayElemAt: ['$costCentre', 0],
          },
        },
      },
      // Sort by most recent first
      {
        $sort: { actedAt: -1 },
      }
    );

    try {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/4df6bb03-2191-446a-93ae-c093fcd724e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ApprovalService.ts:1292',message:'getApprovalHistory: Executing aggregation',data:{pipelineLength:pipeline.length,skip,limit},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      
      // Get total count
      const countPipeline = [...pipeline, { $count: 'total' }];
      const countResult = await ApprovalInstance.aggregate(countPipeline);
      const total = countResult[0]?.total || 0;

      // Add pagination
      pipeline.push({ $skip: skip }, { $limit: limit });

      const history = await ApprovalInstance.aggregate(pipeline);

      logger.debug(
        { total, pageResultCount: history?.length ?? 0 },
        'ApprovalService.getApprovalHistory: aggregation complete'
      );

      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/4df6bb03-2191-446a-93ae-c093fcd724e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ApprovalService.ts:1303',message:'getApprovalHistory: Aggregation successful',data:{historyCount:history?.length||0,total},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion

      return {
        data: history || [],
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit) || 0,
        },
      };
    } catch (error: any) {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/4df6bb03-2191-446a-93ae-c093fcd724e4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ApprovalService.ts:1313',message:'getApprovalHistory: Aggregation error',data:{error:error?.message||error,stack:error?.stack},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      
      logger.error({ 
        error: error?.message || error, 
        filters,
        employeeFilter,
        pagination 
      }, 'Error in getApprovalHistory aggregation');
      
      // Return empty result instead of throwing
      return {
        data: [],
        pagination: {
          page,
          limit,
          total: 0,
          pages: 0,
        },
      };
    }
  }
}


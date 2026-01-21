import mongoose from 'mongoose';

import { ApprovalInstance, IApprovalInstance, ApprovalStatus } from '../models/ApprovalInstance';
import { ApprovalMatrix, IApprovalMatrix, IApprovalLevel, ApprovalType, ParallelRule } from '../models/ApprovalMatrix';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { ExpenseReportStatus } from '../utils/enums';

import { logger } from '@/config/logger';
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

        const instance = new ApprovalInstance({
            companyId,
            matrixId: matrix._id,
            requestId,
            requestType,
            currentLevel: 1,
            status: ApprovalStatus.PENDING,
      history: [],
    });

    const nextState = await this.evaluateLevel(instance as any, matrix as any, 1, requestData);
    instance.currentLevel = nextState.levelNumber;
    instance.status = nextState.status;

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

      const pendingForUser: any[] = [];
      for (const instance of pendingInstances) {
        try {
          // Defensive: Ensure matrix and level config present
          const matrix = instance.matrixId as any;
          if (!matrix) { 
            logger.warn({ instanceId: instance._id }, 'Matrix not found for instance'); 
            continue; 
          }
          
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
          let isAuthorized = false;

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

          // Only actionable for *current* level approvers:
          if (!isAuthorized) {
            logger.debug({
              instanceId: instance._id,
              userId: user._id,
              isUserBasedApproval,
              approverIds: approverIds.slice(0, 3),
              level: instance.currentLevel
            }, 'User is not authorized for this approval level');
            continue;
          }
          
          // Parallel ALL/ANY: if this user already acted at this level, don't show it again
          const alreadyActed = instance.history?.some(
            (h: any) =>
              h.levelNumber === instance.currentLevel &&
              h.approverId?.toString?.() === userId
          );
          if (alreadyActed) {
            logger.debug({ instanceId: instance._id, userId }, 'User already acted on this approval');
            continue;
          }
          // Fetch details for this report
          let requestDetails: any = null;
            if (instance.requestType === 'EXPENSE_REPORT') {
            requestDetails = await ExpenseReport.findById(instance.requestId)
              .select('name totalAmount fromDate toDate status userId notes createdAt projectId costCentreId')
              .populate('userId', 'name email')
              .populate('projectId', 'name code')
              .lean()
              .exec();
          }
          if (!requestDetails) continue;
          const expenses = await Expense.find({ reportId: instance.requestId })
            .populate('categoryId', 'name')
            .populate('receiptPrimaryId', '_id storageUrl mimeType filename')
            .populate('receiptIds', '_id storageUrl mimeType filename')
            .lean().exec();
          const mappedExpenses = expenses.map((exp: any) => ({ ...exp, receiptUrl: exp.receiptPrimaryId?.storageUrl || null }));
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
              expenses: mappedExpenses,
              dateRange: { from: requestDetails.fromDate, to: requestDetails.toDate }
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
      
      logger.info({ 
        userId, 
        totalFiltered: pendingForUser.length, 
        paginatedCount: paginatedResults.length,
        page,
        limit
      }, 'getPendingApprovalsForUser - Complete');
      
      return { data: paginatedResults, total: pendingForUser.length };
    } catch (err) {
      logger.error({ err, userId }, 'getPendingApprovalsForUser: Fatal error');
      return { data: [], total: 0 };
    }
  }
  // ... any other methods ...

    private static async checkLevelCompletion(instance: IApprovalInstance, levelConfig: IApprovalLevel): Promise<boolean> {
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

    private static async finalizeApproval(instance: IApprovalInstance): Promise<void> {
        if (instance.requestType === 'EXPENSE_REPORT') {
            await ExpenseReport.findByIdAndUpdate(instance.requestId, {
                status: ExpenseReportStatus.APPROVED,
        approvedAt: new Date(),
      }).exec();

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
                if (level === 1) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L1;
                else if (level === 2) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L2;
                else if (level === 3) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L3;
                else if (level === 4) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L4;
                else if (level === 5) reportStatus = ExpenseReportStatus.PENDING_APPROVAL_L5;
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
      const currentLevelConfig = matrix.levels.find((l) => l.levelNumber === instance.currentLevel);
            if (!currentLevelConfig) return;

      let requestData: any = null;
            if (instance.requestType === 'EXPENSE_REPORT') {
                requestData = await ExpenseReport.findById(instance.requestId).exec();
            }
            if (!requestData) return;

            const { ApprovalMatrixNotificationService } = await import('./approvalMatrixNotification.service');
      await ApprovalMatrixNotificationService.notifyApprovalRequired(instance, currentLevelConfig as any, requestData);
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
      const currentLevelConfig = matrix.levels?.find(l => l.levelNumber === instance.currentLevel);
      if (!currentLevelConfig) throw new Error('Configuration error: Current level not found');
      // Validate User Permission
      const user = await User.findById(userId).populate('roles').exec();
      if (!user) throw new Error('User not found');
      const userRoleIds = (user.roles || []).map(r => r._id ? r._id.toString() : r.toString());
      // Check if user is authorized for this level
      let isAuthorized = false;
      let authorizedRole = null;

      if (currentLevelConfig.approverUserIds && currentLevelConfig.approverUserIds.length > 0) {
        // New format: check if user ID is directly in the approver list
        const approverUserIds = currentLevelConfig.approverUserIds.map(id => id.toString());
        isAuthorized = approverUserIds.includes(userId);
      } else if (currentLevelConfig.approverRoleIds && currentLevelConfig.approverRoleIds.length > 0) {
        // Old format: check if user has matching role
        authorizedRole = (currentLevelConfig.approverRoleIds || []).find(rId => userRoleIds.includes(rId?.toString()));
        isAuthorized = !!authorizedRole;
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
      instance.history.push({
        levelNumber: instance.currentLevel,
        status: historyStatus,
        approverId: new mongoose.Types.ObjectId(userId),
        roleId: authorizedRole ? new mongoose.Types.ObjectId(authorizedRole) : undefined,
        timestamp: new Date(),
        comments
      });
      // 3. Evaluate State Change
      if (action === 'REJECT') {
        instance.status = ApprovalStatus.REJECTED;
        await instance.save();
        if (instance.requestType === 'EXPENSE_REPORT') {
          await ExpenseReport.findByIdAndUpdate(instance.requestId, { status: ExpenseReportStatus.REJECTED, rejectedAt: new Date() });
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
      const levelComplete = await this.checkLevelCompletion(instance, currentLevelConfig as any);
      if (levelComplete) {
        const nextLevelNum = instance.currentLevel + 1;
        let requestData = null;
        if (instance.requestType === 'EXPENSE_REPORT') {
          requestData = await ExpenseReport.findById(instance.requestId).exec();
        }
        // Evaluate next level
        const nextState = await ApprovalService.evaluateLevel(instance as any, matrix as any, nextLevelNum, requestData);
        instance.currentLevel = nextState.levelNumber;
        instance.status = nextState.status;
        await instance.save();
        if (instance.status === ApprovalStatus.PENDING) {
          await ApprovalService.syncRequestStatus(instance);
          // Notify requester that their report was approved at the previous level
          const completedLevel = instance.currentLevel > 1 ? instance.currentLevel - 1 : 1;
          await ApprovalService.notifyStatusChange(instance, 'APPROVED', comments, completedLevel);
          // Notify next level approvers
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
    } catch (error) {
      logger.error({ error, instanceId, userId, action }, 'Approval action failed: Defensive catch');
      throw new Error((error && (error as any).message) || 'Approval action failed');
    }
  }

  /**
   * Get approval history for a user with filtering
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

    // Build aggregation pipeline
    const pipeline: any[] = [
      // Match instances where user has acted
      {
        $match: {
          'history.approverId': filters.actedBy,
        },
      },
      // Unwind history to get individual actions
      {
        $unwind: '$history',
      },
      // Filter history entries for this user
      {
        $match: {
          'history.approverId': filters.actedBy,
          ...(filters.actionType && { 'history.status': filters.actionType }),
          ...(filters.dateRange && {
            'history.timestamp': filters.dateRange,
          }),
        },
      },
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
                category: { $arrayElemAt: ['$category.name', 0] },
                categoryId: 1,
              },
            },
          ],
          as: 'expenses',
        },
      },
      // Project and format results
      {
        $project: {
          _id: '$history._id',
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
      },
    ];

    // Get total count
    const countPipeline = [...pipeline, { $count: 'total' }];
    const countResult = await ApprovalInstance.aggregate(countPipeline);
    const total = countResult[0]?.total || 0;

    // Add pagination
    pipeline.push({ $skip: skip }, { $limit: limit });

    const history = await ApprovalInstance.aggregate(pipeline);

    return {
      data: history,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }
}


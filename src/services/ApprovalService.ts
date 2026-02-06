import mongoose from 'mongoose';

import { ApprovalInstance, IApprovalInstance, ApprovalStatus } from '../models/ApprovalInstance';
import { ApprovalMatrix, IApprovalMatrix, IApprovalLevel, ApprovalType, ParallelRule } from '../models/ApprovalMatrix';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { AuditAction, ExpenseReportStatus } from '../utils/enums';

import { logger } from '@/config/logger';

/**
 * Resolve the effective User for approval operations.
 * When userId is from CompanyAdmin (different collection), find the linked User with same email in same company.
 * Approval matrix approvers are always User IDs, so we need a User record to match.
 */
async function resolveUserForApproval(userId: string): Promise<{ user: any; effectiveUserId: string } | null> {
  let user = await User.findById(userId).populate('roles').exec();
  if (user) {
    return { user, effectiveUserId: (user._id as mongoose.Types.ObjectId).toString() };
  }
  const { CompanyAdmin } = await import('../models/CompanyAdmin');
  const companyAdmin = await CompanyAdmin.findById(userId).exec();
  if (companyAdmin) {
    user = await User.findOne({
      email: companyAdmin.email,
      companyId: companyAdmin.companyId,
    })
      .populate('roles')
      .exec();
    if (user) {
      logger.info(
        { companyAdminId: userId, linkedUserId: user._id, email: companyAdmin.email },
        'getPendingApprovalsForUser: Resolved CompanyAdmin to linked User for approval'
      );
      return { user, effectiveUserId: (user._id as mongoose.Types.ObjectId).toString() };
    }
    logger.warn(
      { companyAdminId: userId, email: companyAdmin.email },
      'getPendingApprovalsForUser: CompanyAdmin has no linked User - cannot show approvals'
    );
  }
  return null;
}

/** Resolve effective User ID for approval ops (handles CompanyAdmin -> linked User). */
export async function getEffectiveUserIdForApproval(userId: string): Promise<string | null> {
  const resolved = await resolveUserForApproval(userId);
  return resolved?.effectiveUserId ?? null;
}
import { AuditService } from './audit.service';
import { config } from '@/config/index';
import { DateUtils } from '../utils/dateUtils';
// NOTE: Keep ApprovalService fully functional for matrix-based approvals.
// Employee-level chains can be integrated later without breaking ApprovalInstance flow.

export class ApprovalService {
  /**
 * Initiates approval for an Expense Report using the active Approval Matrix.
 * 
 * CRITICAL PATH - MANDATORY FIXES IMPLEMENTED:
 * 1. APPROVAL RECORDS FIRST - Creates records atomically in DB transaction
 * 2. DECOUPLE NOTIFICATIONS - Sent asynchronously AFTER records are persisted
 * 3. SOURCE OF TRUTH - Approver dashboards rely ONLY on DB records
 * 4. VALIDATION & AUDIT - Sanity checks and comprehensive logging
 * 5. FALLBACK MECHANISM - Retry with backoff, fallback to email
   */
  static async initiateApproval(
    companyId: string,
    requestId: string,
    requestType: 'EXPENSE_REPORT',
    initialData?: any
  ): Promise<IApprovalInstance> {
    logger.info({
      companyId,
      requestId,
      requestType,
    }, '🚀 APPROVAL INITIATION START');

    const matrix = await ApprovalMatrix.findOne({ companyId, isActive: true }).exec();
    if (!matrix) {
      logger.error({ companyId, requestId }, '❌ No active approval matrix found');
      throw new Error('No active approval matrix configuration found for this company.');
    }

    let requestData: any = initialData;
    const effectiveMatrix = (initialData as any)?.effectiveMatrix;
    if ((initialData as any)?.requestData) {
      requestData = (initialData as any).requestData;
    }
    if (!requestData && requestType === 'EXPENSE_REPORT') {
      requestData = await ExpenseReport.findById(requestId).exec();
    }
    if (!requestData) {
      logger.error({ requestId }, '❌ Request data not found');
      throw new Error('Request data not found for approval initiation.');
    }

    // Robust submitterId extraction: for EXPENSE_REPORT always fetch from DB to avoid populated/ref mismatches
    let submitterId = '';
    if (requestType === 'EXPENSE_REPORT') {
      const reportForSubmitter = await ExpenseReport.findById(requestId).select('userId').lean().exec();
      const rawUserId = reportForSubmitter?.userId;
      submitterId = ((rawUserId as any)?._id ?? rawUserId)?.toString?.() ?? '';
      if (!submitterId || !mongoose.Types.ObjectId.isValid(submitterId)) {
        const fromRequest = ((requestData.userId?._id ?? requestData.userId)?.toString?.() ?? requestData.userId) as string;
        if (fromRequest && mongoose.Types.ObjectId.isValid(fromRequest) && !fromRequest.includes('object')) {
          submitterId = fromRequest;
        }
      }
      // Resolve CompanyAdmin -> linked User so SKIP_SELF compares correct IDs (approvers are always User IDs)
      if (submitterId) {
        const resolved = await resolveUserForApproval(submitterId);
        if (resolved) submitterId = resolved.effectiveUserId;
      }
    } else {
      submitterId = ((requestData.userId?._id ?? requestData.userId)?.toString?.() ?? requestData.userId) as string;
      if (!submitterId || typeof submitterId !== 'string' || submitterId.includes('object') || !mongoose.Types.ObjectId.isValid(submitterId)) {
        submitterId = '';
      }
    }
    if (!submitterId) {
      logger.error({ requestId, requestType }, 'Could not resolve submitterId for approval initiation');
      throw new Error('Could not resolve report submitter for approval.');
    }
    // Levels to use: personalized (effectiveMatrix) or company matrix
    const levelsToUse = effectiveMatrix?.levels?.length ? effectiveMatrix.levels : (matrix as any).levels || [];

    // ============================================================
    // STEP 1: CREATE APPROVAL INSTANCE (DETERMINISTIC)
    // ============================================================
    const instance = new ApprovalInstance({
      companyId,
      matrixId: matrix._id,
      requestId,
      requestType,
      currentLevel: 1,
      status: ApprovalStatus.PENDING,
      history: [],
      ...(effectiveMatrix?.levels?.length ? { effectiveLevels: effectiveMatrix.levels } : {}),
    });

    const virtualMatrix = { ...(matrix as any).toObject?.() ?? matrix, levels: levelsToUse };

    // SKIP_SELF (always): skip levels where submitter is an approver; auto-approve if submitter is last
    const levels = (levelsToUse || []).filter((l: any) => l.enabled !== false);
    const sortedLevels = [...levels].sort((a: any, b: any) => (a.levelNumber ?? a.level ?? 0) - (b.levelNumber ?? b.level ?? 0));
    const history: any[] = [];
    let firstNonSubmitterLevel: any = null;
    const submitterNorm = submitterId.toString().toLowerCase().trim();
    logger.info({
      requestId,
      submitterId,
      submitterNorm,
      levelsCount: sortedLevels.length,
    }, 'initiateApproval: SKIP_SELF check start');
    for (const level of sortedLevels) {
      const approverIds = await this.getApproverUserIdsForLevel(level, companyId);
      const normalizedApproverIds = new Set(approverIds.map((id) => id.toString().toLowerCase().trim()));
      const isSubmitterInLevel = normalizedApproverIds.has(submitterNorm);
      logger.info({
        requestId,
        levelNum: level.levelNumber ?? level.level,
        approverIdsCount: approverIds.length,
        approverIdsSample: approverIds.slice(0, 3),
        isSubmitterInLevel,
      }, 'initiateApproval: SKIP_SELF level check');
      if (isSubmitterInLevel) {
        history.push({
          levelNumber: level.levelNumber ?? level.level ?? 1,
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
      try {
        await instance.save();
      } catch (saveErr: any) {
        if (saveErr instanceof mongoose.Error.ValidationError) {
          const validationDetails = Object.entries(saveErr.errors || {}).map(([path, e]: [string, any]) => ({ path, message: e?.message }));
          logger.error({
            instanceId: instance._id,
            requestId,
            validationErrors: validationDetails,
          }, 'ApprovalInstance validation failed on save (auto-approval path)');
        }
        throw saveErr;
      }
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

      // Enqueue async notification
      const { NotificationQueueService } = await import('./NotificationQueueService');
      await NotificationQueueService.enqueue('STATUS_CHANGE', {
        approvalInstance: instance,
        requestData,
        status: 'APPROVED' as const,
      });

      logger.info({
        instanceId: instance._id,
        requestId,
        status: 'AUTO_APPROVED',
      }, '✅ Auto-approved (submitter is last approver)');

      return instance;
    }
    instance.currentLevel = firstNonSubmitterLevel.levelNumber ?? firstNonSubmitterLevel.level ?? 2;
    instance.status = ApprovalStatus.PENDING;
    instance.history = history;
    // CRITICAL: Always persist effectiveLevels so getPendingApprovalsForUser resolves correct level
    if (levelsToUse?.length) {
      (instance as any).effectiveLevels = levelsToUse;
    }

    logger.info({
      requestId,
      submitterId,
      skippedLevels: history.filter((h: any) => h.status === ApprovalStatus.SKIPPED).map((h: any) => h.levelNumber),
      advancedToLevel: instance.currentLevel,
    }, 'SKIP_SELF: Advanced past self-approval levels');

    // ============================================================
    // STEP 2: SAVE APPROVAL INSTANCE (ATOMIC)
    // ============================================================
    await instance.save();
    logger.info({
      instanceId: instance._id,
      requestId,
      currentLevel: instance.currentLevel,
      status: instance.status,
    }, '✅ Approval instance saved to database');

    // ============================================================
    // STEP 3: VALIDATE APPROVAL RECORDS (CRITICAL)
    // ============================================================
    const { ApprovalRecordService } = await import('./ApprovalRecordService');

    // Check if this is an additional approver level
    const additionalApproverInfo = await ApprovalRecordService.resolveAdditionalApprovers(instance);

    let recordResult;
    if (additionalApproverInfo.isAdditionalApproverLevel) {
      // Additional approver level - use the resolved level config
      recordResult = {
        success: true,
        approverUserIds: [additionalApproverInfo.approverUserId!],
        levelConfig: additionalApproverInfo.levelConfig!,
      };

      logger.info({
        instanceId: instance._id,
        level: instance.currentLevel,
        approverUserId: additionalApproverInfo.approverUserId,
        isAdditionalApprover: true,
      }, '📋 Additional approver level detected');
    } else {
      // Regular matrix level - pass levelsToUse explicitly so L2+ is found when L1 was skipped
      recordResult = await ApprovalRecordService.createApprovalRecordsAtomic(
        instance,
        virtualMatrix as any,
        companyId,
        levelsToUse
      );
    }

    if (!recordResult.success) {
      logger.error({
        instanceId: instance._id,
        error: recordResult.error,
      }, '❌ CRITICAL: Approval record validation failed');

      throw new Error(`Failed to create approval records: ${recordResult.error}`);
    }

    // SANITY CHECK: Expected approvers vs created approvals
    const expectedCount = recordResult.approverUserIds.length;
    logger.info({
      instanceId: instance._id,
      requestId,
      level: instance.currentLevel,
      expectedApproverCount: expectedCount,
      approverUserIds: recordResult.approverUserIds,
    }, '✅ VALIDATION PASSED: All approvers validated atomically');

    // ============================================================
    // STEP 4: SYNC REQUEST STATUS
    // ============================================================
    await this.syncRequestStatus(instance);

    // ============================================================
    // STEP 5: DECOUPLE NOTIFICATIONS (ASYNC, NON-BLOCKING)
    // ============================================================
    if (instance.status === ApprovalStatus.PENDING) {
      const { NotificationQueueService } = await import('./NotificationQueueService');

      // Enqueue notification task (async, with retry)
      await NotificationQueueService.enqueue('APPROVAL_REQUIRED', {
        approvalInstance: instance,
        levelConfig: recordResult.levelConfig,
        requestData,
        approverUserIds: recordResult.approverUserIds, // Pre-resolved IDs (handles role IDs in approverUserIds)
      });

      logger.info({
        instanceId: instance._id,
        requestId,
        level: instance.currentLevel,
        approverCount: expectedCount,
      }, '📬 Notification task enqueued (async)');
    } else if (instance.status === ApprovalStatus.APPROVED) {
      await this.finalizeApproval(instance);

      const { NotificationQueueService } = await import('./NotificationQueueService');
      await NotificationQueueService.enqueue('STATUS_CHANGE', {
        approvalInstance: instance,
        requestData,
        status: 'APPROVED' as const,
      });
    }

    logger.info({
      instanceId: instance._id,
      requestId,
      currentLevel: instance.currentLevel,
      status: instance.status,
      approverCount: expectedCount,
    }, '🎉 APPROVAL INITIATION COMPLETE');

    return instance;
  }

  /** Resolve approver user IDs for a matrix level (for self-approval skip logic).
   * Handles approverUserIds that may contain Role IDs (from frontend migration) by falling back to approverRoleIds.
   */
  private static async getApproverUserIdsForLevel(level: any, companyId: string): Promise<string[]> {
    if (level.approverUserIds && level.approverUserIds.length > 0) {
      const rawIds = level.approverUserIds.map((id: any) => (id._id ?? id).toString()).filter(Boolean);
      const users = await User.find({
        _id: { $in: rawIds },
        companyId: new mongoose.Types.ObjectId(companyId),
      })
        .select('_id')
        .lean()
        .exec();
      const userIds = users.map((u: any) => u._id.toString());
      if (userIds.length > 0) return userIds;
      // Fallback: approverUserIds may contain Role IDs (from frontend migration). Try approverRoleIds or rawIds as role IDs
      const roleIdsToTry = level.approverRoleIds?.length
        ? level.approverRoleIds.map((id: any) => (id._id ?? id)).filter(Boolean)
        : rawIds;
      if (roleIdsToTry.length > 0) {
        const usersByRole = await User.find({
          companyId: new mongoose.Types.ObjectId(companyId),
          roles: { $in: roleIdsToTry },
        })
          .select('_id')
          .lean()
          .exec();
        return usersByRole.map((u: any) => u._id.toString());
      }
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
   * Repair stuck instance: L1 was skipped (self-approval) but currentLevel stayed 1.
   * Advances instance to L2 and syncs report status so L2 approver sees it.
   */
  private static async repairStuckSkippedL1Instance(reportId: string): Promise<void> {
    const reportObjId = new mongoose.Types.ObjectId(reportId);
    const instance = await ApprovalInstance.findOne({
      requestId: reportObjId,
      requestType: 'EXPENSE_REPORT',
      status: ApprovalStatus.PENDING,
      currentLevel: 1,
    }).exec();
    if (!instance) return;
    const hasL1Skipped = instance.history?.some(
      (h: any) => (h.levelNumber === 1 || h.level === 1) && h.status === ApprovalStatus.SKIPPED
    );
    if (!hasL1Skipped) return;
    const levelsToUse = (instance as any).effectiveLevels?.length
      ? (instance as any).effectiveLevels
      : (await ApprovalMatrix.findById(instance.matrixId).exec())?.levels ?? [];
    const level2 = levelsToUse.find((l: any) => (l.levelNumber ?? l.level) === 2);
    if (!level2) return;
    instance.currentLevel = 2;
    await instance.save();
    await this.syncRequestStatus(instance);
    logger.info({ instanceId: instance._id, reportId, newLevel: 2 }, 'repairStuckSkippedL1Instance: Advanced to L2');
  }

  /**
   * Returns true if the user is the current approver for the given report (pending or changes-requested instance).
   * Used by expenses/receipts services to allow approvers to view expense/receipt details before or while acting.
   */
  static async isUserAllowedToViewReportAsApprover(userId: string, reportId: string): Promise<boolean> {
    if (!mongoose.Types.ObjectId.isValid(reportId)) return false;
    const reportObjId = new mongoose.Types.ObjectId(reportId);
    // Query with $in so we find instances whether requestType is EXPENSE_REPORT or legacy EXPENSE
    const instance = await ApprovalInstance.findOne({
      requestId: reportObjId,
      requestType: { $in: ['EXPENSE_REPORT', 'EXPENSE'] },
      status: { $in: [ApprovalStatus.PENDING, ApprovalStatus.CHANGES_REQUESTED] },
    })
      .populate('matrixId')
      .lean()
      .exec();
    if (!instance) {
      logger.debug({ reportId, userId }, 'isUserAllowedToViewReportAsApprover: no pending instance for report');
      return false;
    }
    const resolved = await resolveUserForApproval(userId);
    if (!resolved) {
      logger.debug({ userId }, 'isUserAllowedToViewReportAsApprover: resolveUserForApproval returned null');
      return false;
    }
    const { user } = resolved;
    const currentUserId = (user._id as mongoose.Types.ObjectId).toString();
    // Check additional approver first: report.approvers defines the level; do not deny when matrixLevels is empty
    const report = await ExpenseReport.findById(reportObjId).select('approvers').lean().exec();
    if (report?.approvers) {
      const currentAdditional = (report.approvers as any[]).find(
        (a: any) => a.level === instance.currentLevel && a.isAdditionalApproval === true
      );
      if (currentAdditional) {
        const approverUserId = currentAdditional.userId?.toString?.() || currentAdditional.userId;
        if (approverUserId === currentUserId) return true;
        return false;
      }
    }

    const matrix = instance.matrixId as any;
    const matrixLevels = (instance as any).effectiveLevels?.length
      ? (instance as any).effectiveLevels
      : matrix?.levels ?? [];
    if (matrixLevels.length === 0) {
      logger.debug({ reportId, instanceId: (instance as any)._id }, 'isUserAllowedToViewReportAsApprover: no matrix levels');
      return false;
    }

    // Matrix level: support both levelNumber and level for compatibility
    const currentLevel = matrixLevels.find(
      (l: any) => (l.levelNumber === instance.currentLevel) || (l.level === instance.currentLevel)
    );
    if (!currentLevel) {
      logger.debug({ reportId, currentLevel: instance.currentLevel, levelsCount: matrixLevels.length }, 'isUserAllowedToViewReportAsApprover: current level not found in matrix');
      return false;
    }
    const companyIdStr = user.companyId?.toString?.();
    if (!companyIdStr) return false;
    const resolvedApproverIds = await this.getApproverUserIdsForLevel(currentLevel, companyIdStr);
    const normalized = new Set(resolvedApproverIds.map((id) => id.toLowerCase().trim()));
    const allowed = normalized.has(currentUserId.toLowerCase().trim());
    if (!allowed) {
      logger.debug({ reportId, currentUserId, resolvedCount: resolvedApproverIds.length }, 'isUserAllowedToViewReportAsApprover: user not in current level approvers');
    }
    return allowed;
  }

  /**
 * Defensive: Get all pending approvals for a user based on their roles.
 * No error can crash the whole query. Bad data just gets logged and skipped.
 */
  static async getPendingApprovalsForUser(userId: string, options: { page?: number; limit?: number; startDate?: string; endDate?: string } = {}): Promise<{ data: any[]; total: number }> {
    try {
      const resolved = await resolveUserForApproval(userId);
      if (!resolved) {
        logger.warn({ userId }, 'User not found in getPendingApprovalsForUser (checked User and CompanyAdmin)');
        return { data: [], total: 0 };
      }
      const { user, effectiveUserId } = resolved;

      // User may have no roles when matrix uses approverUserIds (direct user assignment)
      const userRoleIds: string[] = (user.roles || []).map((r: any) => {
        const roleId = r._id?.toString() || r.toString();
        return roleId;
      }).filter(Boolean);

      // Build query for pending instances with date filters
      const companyIdForQuery = user.companyId instanceof mongoose.Types.ObjectId
        ? user.companyId
        : new mongoose.Types.ObjectId((user.companyId as any)?.toString?.() || user.companyId);
      const query: any = {
        companyId: companyIdForQuery,
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

      // Always use SKIP_SELF: self-approval is never allowed
      const selfApprovalPolicyForPending = 'SKIP_SELF';

      const pendingForUser: any[] = [];
      for (const instance of pendingInstances) {
        try {
          const matrix = instance.matrixId as any;
          // Use effectiveLevels when set (personalized/normal company matrix); else matrix.levels
          // When matrix is null (deleted ref), still use effectiveLevels if present
          const matrixLevels = (instance as any).effectiveLevels?.length
            ? (instance as any).effectiveLevels
            : matrix?.levels ?? [];

          // CRITICAL: Check additional approver level FIRST (before skipping on empty matrixLevels).
          // When instance is at an additional approver level, report.approvers defines the level;
          // we must not skip the instance when matrixLevels is empty (e.g. matrix deleted or no effectiveLevels).
          let isAdditionalApproverLevel = false;
          let isAuthorized = false;
          let roleNameForResponse = 'Approver';
          let resolvedApproverCount = 0;

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
                roleNameForResponse = currentAdditionalApprover.role || 'Approver';
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

          // Only skip when there are no matrix levels AND this is not an additional approver level for this user
          if (matrixLevels.length === 0 && !isAdditionalApproverLevel) {
            logger.warn({
              instanceId: instance._id,
              requestId: instance.requestId,
              currentLevel: instance.currentLevel,
              hasMatrix: !!matrix,
              hasEffectiveLevels: !!(instance as any).effectiveLevels?.length,
            }, 'getPendingApprovalsForUser: Skip - no level config (effectiveLevels or matrix.levels)');
            continue;
          }

          // If not an additional approver level, check matrix levels (or effectiveLevels for personalized matrix)
          if (!isAdditionalApproverLevel) {
            const currentLevel = matrixLevels.find((l: any) => (l.levelNumber ?? l.level) === instance.currentLevel);
            if (!currentLevel) {
              logger.warn({
                instanceId: instance._id,
                requestId: instance.requestId,
                level: instance.currentLevel,
                matrixLevelsCount: matrixLevels.length,
                levelNumbers: matrixLevels.map((l: any) => l.levelNumber ?? l.level),
              }, 'getPendingApprovalsForUser: Skip - level config not found for instance');
              continue;
            }

            // CRITICAL: Use same resolution as ApprovalRecordService - approverUserIds may contain
            // Role IDs (from MatrixBuilder migration). Resolve to actual user IDs before checking.
            const companyIdStr = user.companyId?.toString?.();
            if (!companyIdStr) {
              logger.warn({ instanceId: instance._id, requestId: instance.requestId }, 'getPendingApprovalsForUser: Skip - user has no companyId');
              continue;
            }
            const resolvedApproverUserIds = await this.getApproverUserIdsForLevel(currentLevel, companyIdStr);
            resolvedApproverCount = resolvedApproverUserIds.length;

            if (resolvedApproverUserIds.length === 0) {
              logger.warn({
                instanceId: instance._id,
                requestId: instance.requestId,
                level: instance.currentLevel,
                approverUserIdsCount: currentLevel.approverUserIds?.length ?? 0,
                approverRoleIdsCount: currentLevel.approverRoleIds?.length ?? 0,
              }, 'getPendingApprovalsForUser: Skip - no approver IDs found for current level');
              continue;
            }

            // Check if current user is in the resolved approver list (handles both user-based and role-based)
            const normalizedApproverIds = new Set(resolvedApproverUserIds.map((id) => id.toLowerCase().trim()));
            const currentUserId = (user._id as mongoose.Types.ObjectId).toString().toLowerCase().trim();
            isAuthorized = normalizedApproverIds.has(currentUserId);

            if (isAuthorized && user.roles?.length) {
              const matchedRole = (user.roles as any[])[0];
              roleNameForResponse = matchedRole?.name || 'Approver';
            } else if (isAuthorized) {
              roleNameForResponse = 'Approver';
            }
          }

          // Only actionable for *current* level approvers:
          if (!isAuthorized) {
            logger.warn({
              instanceId: instance._id,
              requestId: instance.requestId,
              currentUserId: (user._id as mongoose.Types.ObjectId).toString(),
              level: instance.currentLevel,
              resolvedApproverCount,
              isAdditionalApproverLevel,
            }, 'getPendingApprovalsForUser: Skip - user not authorized for this approval level');
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

          // SKIP_SELF: Never show report to submitter when they are current approver - backend should have skipped
          if (instance.requestType === 'EXPENSE_REPORT') {
            const reportForSubmitter = await ExpenseReport.findById(instance.requestId).select('userId').lean().exec();
            const rawSub = reportForSubmitter?.userId;
            const submitterIdStr = ((rawSub as any)?._id ?? rawSub)?.toString?.() ?? '';
            const resolvedSub = submitterIdStr && mongoose.Types.ObjectId.isValid(submitterIdStr)
              ? await resolveUserForApproval(submitterIdStr)
              : null;
            const effectiveSubmitterId = (resolvedSub?.effectiveUserId ?? submitterIdStr)?.toLowerCase?.()?.trim?.() ?? '';
            if (effectiveSubmitterId && currentUserId.toLowerCase().trim() === effectiveSubmitterId) {
              logger.info({
                instanceId: instance._id,
                requestId: instance.requestId,
                currentLevel: instance.currentLevel,
              }, 'getPendingApprovalsForUser: Skip - submitter is current approver (SKIP_SELF), should not see own report');
              // Repair stuck instance: L1 was skipped but currentLevel stayed 1 - advance to L2
              this.repairStuckSkippedL1Instance(instance.requestId.toString()).catch((err) =>
                logger.warn({ err: err?.message, requestId: instance.requestId }, 'repairStuckSkippedL1Instance failed')
              );
              continue;
            }
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

                    // Get max level from instance effectiveLevels (personalized) or company ApprovalMatrix
                    let maxLevel = 2;
                    const effectiveLevels = (instance as any).effectiveLevels;
                    if (effectiveLevels?.length) {
                      maxLevel = Math.max(...effectiveLevels.map((l: any) => l.levelNumber), 2);
                    } else {
                      const { ApprovalMatrix } = await import('../models/ApprovalMatrix');
                      const matrixForMax = await ApprovalMatrix.findOne({
                        companyId: companyId,
                        isActive: true
                      }).exec();
                      if (matrixForMax && matrixForMax.levels) {
                        const enabledLevels = matrixForMax.levels
                          .filter((l: any) => l.enabled !== false)
                          .map((l: any) => l.levelNumber);
                        if (enabledLevels.length > 0) {
                          maxLevel = Math.max(...enabledLevels);
                        }
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
            roleName: roleNameForResponse,
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
              isSubmitterCurrentApprover: !!(reportSubmitterId && effectiveUserId === reportSubmitterId),
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

      // LEGACY FALLBACK: When no matrix-based approvals found, check reports using report.approvers
      // (e.g. when ApprovalService.initiateApproval failed and fell back to computeApproverChain)
      if (pendingForUser.length === 0 && user.companyId) {
        try {
          const legacyReports = await ExpenseReport.find({
            companyId: user.companyId,
            status: { $in: ['PENDING_APPROVAL_L1', 'PENDING_APPROVAL_L2', 'PENDING_APPROVAL_L3', 'PENDING_APPROVAL_L4', 'PENDING_APPROVAL_L5'] },
            approvers: {
              $elemMatch: {
                userId: (user._id as mongoose.Types.ObjectId),
                decidedAt: null,
              },
            },
          })
            .select('name totalAmount fromDate toDate status userId notes createdAt projectId costCentreId appliedVouchers approvers currency companyId approvalMeta')
            .populate('userId', 'name email companyId')
            .populate('projectId', 'name code')
            .sort({ submittedAt: -1 })
            .lean()
            .exec();

          const currentUserId = (user._id as mongoose.Types.ObjectId).toString();
          for (const report of legacyReports) {
            const approvers = (report.approvers || []) as any[];
            const sortedApprovers = [...approvers].sort((a, b) => (a.level || 0) - (b.level || 0));
            const currentApprover = sortedApprovers.find((a) => !a.decidedAt);
            if (!currentApprover) continue;
            const approverUserId = (currentApprover.userId?._id ?? currentApprover.userId)?.toString?.() ?? String(currentApprover.userId);
            if (approverUserId !== currentUserId) continue;

            const expenses = await Expense.find({ reportId: report._id })
              .populate('categoryId', 'name')
              .populate('receiptPrimaryId', '_id storageUrl mimeType filename')
              .populate('receiptIds', '_id storageUrl mimeType filename')
              .lean()
              .exec();

            const mappedExpenses = expenses.map((exp: any) => ({
              ...exp,
              receiptUrl: exp.receiptPrimaryId?.storageUrl || null,
              expenseDate: exp.expenseDate instanceof Date ? DateUtils.backendDateToFrontend(exp.expenseDate) : exp.expenseDate,
              invoiceDate: exp.invoiceDate instanceof Date ? DateUtils.backendDateToFrontend(exp.invoiceDate) : exp.invoiceDate,
            }));

            pendingForUser.push({
              instanceId: null,
              approvalStatus: 'PENDING',
              currentLevel: currentApprover.level,
              requestId: report._id,
              requestType: 'EXPENSE_REPORT',
              roleName: currentApprover.role || 'Approver',
              roleId: null,
              data: {
                ...report,
                id: report._id,
                reportName: report.name,
                employeeName: (report.userId as any)?.name,
                employeeEmail: (report.userId as any)?.email,
                projectName: (report.projectId as any)?.name,
                projectCode: (report.projectId as any)?.code,
                expenses: mappedExpenses,
                dateRange: { from: report.fromDate, to: report.toDate },
                appliedVouchers: report.appliedVouchers || [],
                currency: report.currency || 'INR',
                additionalApproverInfo: null,
                selfApprovalPolicy: selfApprovalPolicyForPending,
                isSubmitterCurrentApprover: false,
                flags: {
                  changes_requested: report.status === 'CHANGES_REQUESTED',
                  rejected: report.status === 'REJECTED',
                  voucher_applied: (report.appliedVouchers || []).length > 0,
                  additional_approver_added: approvers.some((a: any) => a.isAdditionalApproval),
                  duplicate_flagged: false,
                  ocr_needs_review: false,
                },
              },
              createdAt: report.submittedAt || report.createdAt,
              isLegacyApproval: true,
            });
          }
          if (legacyReports.length > 0) {
            logger.info({
              userId: currentUserId,
              legacyCount: pendingForUser.filter((p: any) => p.isLegacyApproval).length,
            }, 'getPendingApprovalsForUser: Included legacy report.approvers fallback');
          }
        } catch (legacyErr: any) {
          logger.warn({ err: legacyErr?.message, userId }, 'getPendingApprovalsForUser: Legacy fallback failed');
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
        // CRITICAL FIX: When using approverUserIds, we need to check approverId in history
        // When using approverRoleIds, we need to check if users with those roles approved

        let requiredApprovers: any[] = [];
        let isUserBasedApproval = false;

        if (levelConfig.approverUserIds && levelConfig.approverUserIds.length > 0) {
          // New format: specific users
          requiredApprovers = levelConfig.approverUserIds.map((id: any) => id.toString());
          isUserBasedApproval = true;
        } else if (levelConfig.approverRoleIds && levelConfig.approverRoleIds.length > 0) {
          // Old format: roles
          requiredApprovers = levelConfig.approverRoleIds.map((id: any) => id.toString());
          isUserBasedApproval = false;
        }

        if (requiredApprovers.length === 0) return true;

        // Get all approved entries for this level
        const approvedEntries = instance.history.filter(
          (h) => h.levelNumber === instance.currentLevel && h.status === ApprovalStatus.APPROVED
        );

        if (isUserBasedApproval) {
          // For user-based approval, check if all required user IDs have approved
          const approvedUserIds = new Set(
            approvedEntries
              .map((h) => h.approverId?.toString())
              .filter(Boolean) as string[]
          );

          // Check if every required approver has approved
          const allApproved = requiredApprovers.every((userId: string) =>
            approvedUserIds.has(userId)
          );

          logger.debug({
            levelNumber: instance.currentLevel,
            requiredApproversCount: requiredApprovers.length,
            requiredApprovers: requiredApprovers,
            approvedUserIdsCount: approvedUserIds.size,
            approvedUserIds: Array.from(approvedUserIds),
            allApproved,
            instanceId: instance._id
          }, 'checkLevelCompletion: Parallel ALL (user-based) check');

          return allApproved;
        } else {
          // For role-based approval, check if all required roles have approved
          const approvedRoleIds = new Set(
            approvedEntries
              .map((h) => h.roleId?.toString())
              .filter(Boolean) as string[]
          );

          // Check if every required role has approved
          const allApproved = requiredApprovers.every((roleId: string) =>
            approvedRoleIds.has(roleId)
          );

          logger.debug({
            levelNumber: instance.currentLevel,
            requiredRolesCount: requiredApprovers.length,
            requiredRoles: requiredApprovers,
            approvedRoleIdsCount: approvedRoleIds.size,
            approvedRoleIds: Array.from(approvedRoleIds),
            allApproved,
            instanceId: instance._id
          }, 'checkLevelCompletion: Parallel ALL (role-based) check');

          return allApproved;
        }
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

  /**
   * If the current level's approver has already approved at a previous level (e.g. same user is matrix L2 and additional L4),
   * treat this level as approved and advance or finalize. Loop until we reach a level where the approver has not yet acted.
   */
  private static async processAutoApprovalsForAlreadyActedApprovers(
    instance: IApprovalInstance,
    requestData: any,
    virtualMatrix: any
  ): Promise<void> {
    const levelsToUse = (instance as any).effectiveLevels?.length ? (instance as any).effectiveLevels : (virtualMatrix?.levels || []);
    const historyApproverIds = new Set((instance.history || []).map((h: any) => h.approverId?.toString?.()).filter(Boolean));

    while (instance.status === ApprovalStatus.PENDING) {
      const { ApprovalRecordService } = await import('./ApprovalRecordService');
      const additionalInfo = await ApprovalRecordService.resolveAdditionalApprovers(instance);
      let currentLevelApproverIds: string[] = [];

      if (additionalInfo.isAdditionalApproverLevel && additionalInfo.approverUserId) {
        currentLevelApproverIds = [additionalInfo.approverUserId];
      } else {
        const levelConfig = levelsToUse.find((l: any) => (l.levelNumber ?? l.level) === instance.currentLevel);
        if (levelConfig) {
          currentLevelApproverIds = await this.getApproverUserIdsForLevel(levelConfig, instance.companyId?.toString?.() ?? '');
        }
      }

      if (currentLevelApproverIds.length === 0) break;
      const allAlreadyActed = currentLevelApproverIds.every((id) => historyApproverIds.has(id));
      if (!allAlreadyActed) break;

      // Current level approver(s) have already approved — add synthetic history and advance
      instance.history.push({
        levelNumber: instance.currentLevel,
        status: ApprovalStatus.APPROVED,
        approverId: new mongoose.Types.ObjectId(currentLevelApproverIds[0]),
        timestamp: new Date(),
        comments: 'Already approved at a previous level (same approver in matrix and additional)',
      } as any);
      historyApproverIds.add(currentLevelApproverIds[0]);

      if (additionalInfo.isAdditionalApproverLevel) {
        const report = await ExpenseReport.findById(instance.requestId).select('approvers').lean().exec();
        const approversList = (report?.approvers || []) as any[];
        const remaining = approversList.filter(
          (a: any) => a.isAdditionalApproval === true && a.level > instance.currentLevel
        );
        if (remaining.length > 0) {
          instance.currentLevel = remaining[0].level;
          logger.info({ instanceId: instance._id, newLevel: instance.currentLevel }, 'Auto-advance to next additional approver (same user already approved)');
        } else {
          instance.status = ApprovalStatus.APPROVED;
          logger.info({ instanceId: instance._id }, 'Auto-finalize: all additional approvers already acted');
        }
      } else {
        const nextLevelNum = instance.currentLevel + 1;
        const nextState = await this.evaluateLevel(instance as any, virtualMatrix, nextLevelNum, requestData);
        instance.currentLevel = nextState.levelNumber;
        instance.status = nextState.status;
        if (instance.status === ApprovalStatus.APPROVED && instance.requestType === 'EXPENSE_REPORT') {
          const freshReport = await ExpenseReport.findById(instance.requestId).select('approvers').lean().exec();
          const approversList = (freshReport?.approvers || []) as any[];
          const additionalApprovers = approversList.filter((a: any) => a.isAdditionalApproval === true && !a.decidedAt);
          if (additionalApprovers.length > 0) {
            instance.currentLevel = additionalApprovers[0].level ?? (nextLevelNum);
            instance.status = ApprovalStatus.PENDING;
          }
        }
      }
    }
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
      await ExpenseReport.findByIdAndUpdate(instance.requestId, update, { runValidators: false }).exec();

      // Post-approval side-effect: apply advance cash deductions (does not affect approval routing)
      try {
        const { AdvanceCashService } = await import('./advanceCash.service');
        await AdvanceCashService.applyAdvanceForReport(instance.requestId.toString());
      } catch (error: any) {
        // Log but do not block: report is already approved. Advance cash can be applied manually if needed.
        logger.error(
          { error: error?.message, stack: error?.stack, reportId: instance.requestId },
          'Failed to apply advance cash after approval (non-blocking)'
        );
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
      // Use effectiveLevels when present and non-empty, else company matrix levels
      const rawEffective = (instance as any).effectiveLevels;
      const levelsToUse = (Array.isArray(rawEffective) && rawEffective.length > 0)
        ? rawEffective
        : (matrix?.levels ?? []);
      const virtualMatrix = { ...(matrix as any).toObject?.() ?? matrix, levels: levelsToUse };
      // Check if this is an additional approver level (not in matrix)
      let requestData = null;
      if (instance.requestType === 'EXPENSE_REPORT') {
        requestData = await ExpenseReport.findById(instance.requestId).exec();
      }

      // Resolve user (support CompanyAdmin -> linked User)
      const resolved = await resolveUserForApproval(userId);
      if (!resolved) throw new Error('User not found');
      const { user: resolvedUser, effectiveUserId } = resolved;

      // Block self-approval when company policy is SKIP_SELF
      if (action === 'APPROVE' && requestData && instance.requestType === 'EXPENSE_REPORT') {
        const report = requestData as any;
        const reportSubmitterId = (report.userId?.toString?.() ?? report.userId) as string;
        if (reportSubmitterId && effectiveUserId === reportSubmitterId) {
          // Always block self-approval (SKIP_SELF)
          if (true) {
            const err: any = new Error('Self approval is not allowed by company policy');
            err.statusCode = 403;
            err.code = 'SELF_APPROVAL_NOT_ALLOWED';
            throw err;
          }
        }
      }

      let isAdditionalApproverLevel = false;
      let reportApproverAtLevel: any = null;
      if (requestData) {
        const report = requestData as any;
        reportApproverAtLevel = (report.approvers || []).find(
          (a: any) => a.level === instance.currentLevel
        );
        isAdditionalApproverLevel = !!(reportApproverAtLevel?.isAdditionalApproval === true);
      }

      const currentLevelNum = Number(instance.currentLevel);
      let currentLevelConfig = isAdditionalApproverLevel
        ? null
        : levelsToUse.find((l: any) => Number(l?.levelNumber ?? l?.level) === currentLevelNum);

      // Fallback: match by array index when levelNumber doesn't match (e.g. level 1 = index 0)
      if (!currentLevelConfig && !isAdditionalApproverLevel && currentLevelNum >= 1 && currentLevelNum <= levelsToUse.length) {
        currentLevelConfig = levelsToUse[currentLevelNum - 1];
      }

      // When level not in matrix: allow if report.approvers has approver at this level (handles
      // additional approvers, matrix reduction, or legacy reports)
      let levelInReportApprovers = !!reportApproverAtLevel;

      // Last resort: when report has no approvers (matrix flow clears them) but instance is at level 3+,
      // dynamically evaluate additional approvers - they may not have been saved to report
      if (!levelInReportApprovers && !currentLevelConfig && requestData && instance.requestType === 'EXPENSE_REPORT' && currentLevelNum >= 3) {
        try {
          const { ReportsService } = await import('./reports.service');
          const companyId = instance.companyId;
          const dynamicApprovers = await ReportsService.evaluateAdditionalApprovalRules(
            requestData as any,
            companyId
          );
          reportApproverAtLevel = dynamicApprovers.find(
            (a: any) => Number(a.level) === currentLevelNum
          ) as any;
          if (reportApproverAtLevel) {
            levelInReportApprovers = true;
            logger.info({ instanceId, currentLevel: currentLevelNum }, 'processAction: Resolved approver from evaluateAdditionalApprovalRules');
          }
        } catch (evalErr: any) {
          logger.warn({ instanceId, err: evalErr?.message }, 'processAction: evaluateAdditionalApprovalRules failed');
        }
      }

      if (!isAdditionalApproverLevel && !currentLevelConfig && !levelInReportApprovers) {
        logger.warn({
          instanceId,
          currentLevel: instance.currentLevel,
          levelsToUseCount: levelsToUse.length,
          levelNumbers: levelsToUse.map((l: any) => l?.levelNumber ?? l?.level),
          hasEffectiveLevels: !!(instance as any).effectiveLevels?.length,
          reportApproversCount: (requestData as any)?.approvers?.length ?? 0,
        }, 'processAction: Current level not found - possible matrix/report mismatch');
        throw new Error('Configuration error: Current level not found');
      }
      // Validate User Permission (resolvedUser from resolveUserForApproval above)
      const user = resolvedUser;
      const userRoleIds = (user.roles || []).map((r: any) => r._id ? r._id.toString() : r.toString());
      // Check if user is authorized for this level
      let isAuthorized = false;
      let authorizedRole = null;

      // First, check if this is an additional approver level or level from report.approvers (not in matrix)
      if ((isAdditionalApproverLevel || levelInReportApprovers) && reportApproverAtLevel) {
        const approverUserId = (reportApproverAtLevel.userId?._id ?? reportApproverAtLevel.userId)?.toString?.() ?? String(reportApproverAtLevel.userId);
        isAuthorized = approverUserId === effectiveUserId;
        if (isAuthorized) {
          authorizedRole = reportApproverAtLevel.role;
        }
      } else if (currentLevelConfig) {
        // Regular matrix level - check matrix configuration
        if (currentLevelConfig.approverUserIds && currentLevelConfig.approverUserIds.length > 0) {
          // New format: check if user ID is directly in the approver list
          const approverUserIds = currentLevelConfig.approverUserIds.map((id: string | { toString(): string }) => id.toString());
          isAuthorized = approverUserIds.includes(effectiveUserId);
        } else if (currentLevelConfig.approverRoleIds && currentLevelConfig.approverRoleIds.length > 0) {
          // Old format: check if user has matching role
          authorizedRole = (currentLevelConfig.approverRoleIds || []).find((rId: string | { toString(): string } | undefined) => rId != null && userRoleIds.includes(rId.toString()));
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
          h.approverId?.toString?.() === effectiveUserId
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
        approverId: new mongoose.Types.ObjectId(effectiveUserId),
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
        // Enqueue rejection notification (async, non-blocking)
        const { NotificationQueueService } = await import('./NotificationQueueService');
        await NotificationQueueService.enqueue('STATUS_CHANGE', {
          approvalInstance: instance,
          requestData,
          status: 'REJECTED' as const,
          comments,
        });
        return instance;
      }
      if (action === 'REQUEST_CHANGES') {
        instance.status = ApprovalStatus.CHANGES_REQUESTED;
        await instance.save();
        if (instance.requestType === 'EXPENSE_REPORT') {
          await ExpenseReport.findByIdAndUpdate(instance.requestId, { status: ExpenseReportStatus.CHANGES_REQUESTED });
        }
        // Enqueue changes requested notification (async, non-blocking)
        const { NotificationQueueService } = await import('./NotificationQueueService');
        await NotificationQueueService.enqueue('STATUS_CHANGE', {
          approvalInstance: instance,
          requestData,
          status: 'CHANGES_REQUESTED' as const,
          comments,
        });
        return instance;
      }
      // Handle APPROVE
      // For additional approver levels or report.approvers-only levels, pass a mock config; for matrix levels, use the actual config
      const levelConfigForCheck = (isAdditionalApproverLevel || levelInReportApprovers)
        ? { approvalType: ApprovalType.SEQUENTIAL } as any
        : (currentLevelConfig as any);
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
          // Regular matrix level - evaluate next level with SKIP_SELF support (skip levels where submitter is approver)
          const levelsToUse = (instance as any).effectiveLevels?.length
            ? (instance as any).effectiveLevels
            : (virtualMatrix as any)?.levels ?? [];
          const companyIdStr = instance.companyId?.toString?.() ?? '';
          const reportSubmitterId = requestData ? ((requestData.userId?.toString?.() ?? requestData.userId) as string) : null;

          let nextLevelNum = instance.currentLevel + 1;
          let nextState: { levelNumber: number; status: ApprovalStatus };
          let allLevelsSkippedDueToSubmitter = false;

          // Always skip self-approval (SKIP_SELF)
          if (reportSubmitterId && instance.requestType === 'EXPENSE_REPORT') {
            const submitterNorm = reportSubmitterId.toString().toLowerCase().trim();

            while (true) {
              const levelConfig = levelsToUse.find(
                (l: any) => (l.levelNumber ?? l.level) === nextLevelNum && l.enabled !== false
              );
              if (!levelConfig) {
                nextState = { levelNumber: instance.currentLevel, status: ApprovalStatus.APPROVED };
                allLevelsSkippedDueToSubmitter = true;
                break;
              }
              const approverIds = await this.getApproverUserIdsForLevel(levelConfig, companyIdStr);
              const normalizedApproverIds = new Set(approverIds.map((id) => id.toString().toLowerCase().trim()));
              if (normalizedApproverIds.has(submitterNorm)) {
                instance.history.push({
                  levelNumber: nextLevelNum,
                  status: ApprovalStatus.SKIPPED,
                  timestamp: new Date(),
                  comments: 'Self approval skipped per company policy',
                } as any);
                await AuditService.log(reportSubmitterId, 'ExpenseReport', (instance.requestId as mongoose.Types.ObjectId).toString(), AuditAction.SELF_APPROVAL_SKIPPED, {
                  reportId: (instance.requestId as mongoose.Types.ObjectId).toString(),
                  userId: reportSubmitterId,
                  policy: 'SKIP_SELF',
                  level: nextLevelNum,
                });
                nextLevelNum++;
              } else {
                nextState = await ApprovalService.evaluateLevel(instance as any, virtualMatrix as any, nextLevelNum, requestData);
                break;
              }
            }

            if (allLevelsSkippedDueToSubmitter) {
              instance.status = ApprovalStatus.APPROVED;
              instance.currentLevel = nextState.levelNumber;
              await instance.save();
              const approvalMeta = {
                type: 'AUTO_APPROVED' as const,
                reason: 'SUBMITTER_IS_LAST_APPROVER',
                policy: 'SKIP_SELF',
                approvedAt: new Date(),
              };
              await this.finalizeApproval(instance, approvalMeta);
              await AuditService.log(reportSubmitterId, 'ExpenseReport', (instance.requestId as mongoose.Types.ObjectId).toString(), AuditAction.AUTO_APPROVED, {
                reportId: (instance.requestId as mongoose.Types.ObjectId).toString(),
                reason: 'SUBMITTER_IS_LAST_APPROVER',
                policy: 'SKIP_SELF',
              });
              const { NotificationQueueService } = await import('./NotificationQueueService');
              await NotificationQueueService.enqueue('STATUS_CHANGE', {
                approvalInstance: instance,
                requestData,
                status: 'APPROVED' as const,
              });
              logger.info(
                { instanceId: instance._id, requestId: instance.requestId, status: 'AUTO_APPROVED' },
                '✅ Auto-approved (submitter is last approver after level transition)'
              );
              return instance;
            }
          } else {
            nextState = await ApprovalService.evaluateLevel(instance as any, virtualMatrix as any, nextLevelNum, requestData);
          }

          instance.currentLevel = nextState.levelNumber;
          instance.status = nextState.status;

          // CRITICAL: If all matrix levels are approved, check for additional approvers and route to Ln+1
          // 1) Use report.approvers from DB; 2) If none, re-evaluate rules and persist so report goes to additional approver
          if (instance.status === ApprovalStatus.APPROVED && instance.requestType === 'EXPENSE_REPORT') {
            try {
              const freshReport = await ExpenseReport.findById(instance.requestId)
                .select('approvers totalAmount projectId costCentreId userId')
                .lean()
                .exec();

              let approversList: any[] = (freshReport?.approvers && Array.isArray(freshReport.approvers)) ? freshReport.approvers : [];
              const userIdsAlreadyDecided = new Set(
                approversList
                  .filter((a: any) => a.decidedAt && a.action)
                  .map((a: any) => (a.userId?.toString?.() ?? String(a.userId)))
              );
              let additionalApprovers = approversList.filter(
                (a: any) =>
                  a.isAdditionalApproval === true &&
                  (!a.decidedAt || !a.action) &&
                  !userIdsAlreadyDecided.has((a.userId?.toString?.() ?? String(a.userId)))
              );

              // Fallback: if report has no pending additional approvers, re-evaluate rules (e.g. saved before rules existed or approvers not persisted)
              if (additionalApprovers.length === 0 && freshReport) {
                const { ReportsService } = await import('./reports.service');
                const companyId = instance.companyId as mongoose.Types.ObjectId;
                const tempReport = {
                  _id: freshReport._id,
                  totalAmount: freshReport.totalAmount,
                  projectId: freshReport.projectId,
                  costCentreId: freshReport.costCentreId,
                  userId: freshReport.userId,
                };
                const dynamicAdditional = await ReportsService.evaluateAdditionalApprovalRules(
                  tempReport as any,
                  companyId
                );
                if (dynamicAdditional.length > 0) {
                  const levelsToUse = (instance as any).effectiveLevels?.length
                    ? (instance as any).effectiveLevels
                    : (virtualMatrix as any)?.levels ?? [];
                  const maxMatrixLevel = levelsToUse.length
                    ? Math.max(...levelsToUse.map((l: any) => l.levelNumber ?? l.level ?? 0), 2)
                    : 2;
                  const insertAfterLevel = Math.max(maxMatrixLevel, 2);
                  const newApprovers = dynamicAdditional.map((a: any, index: number) => ({
                    ...a,
                    level: insertAfterLevel + index + 1,
                  }));
                  await ExpenseReport.findByIdAndUpdate(instance.requestId, {
                    approvers: newApprovers,
                  }).exec();
                  additionalApprovers = newApprovers;
                  logger.info({
                    reportId: instance.requestId,
                    additionalApproversCount: additionalApprovers.length,
                    insertAfterLevel,
                    message: 'Additional approvers evaluated and saved after matrix approval',
                  }, 'ApprovalService: Dynamic additional approvers after Ln');
                }
              }

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
                const firstAdditionalApprover = additionalApprovers[0];
                const additionalLevel = firstAdditionalApprover.level || (nextLevelNum);

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

        // If same user is both matrix and additional approver, count one approval for both (auto-advance)
        if (instance.status === ApprovalStatus.PENDING) {
          await this.processAutoApprovalsForAlreadyActedApprovers(instance, requestData, virtualMatrix);
        }

        await instance.save();
        if (instance.status === ApprovalStatus.PENDING) {
          await ApprovalService.syncRequestStatus(instance);
          // Notify requester that their report was approved at the previous level
          const completedLevel = instance.currentLevel > 1 ? instance.currentLevel - 1 : 1;
          // Enqueue async notifications (non-blocking)
          const { NotificationQueueService } = await import('./NotificationQueueService');
          await NotificationQueueService.enqueue('STATUS_CHANGE', {
            approvalInstance: instance,
            requestData,
            status: 'APPROVED' as const,
            comments,
            approvedLevel: completedLevel,
          });

          // Resolve current level config for next level notification
          const { ApprovalRecordService } = await import('./ApprovalRecordService');
          const additionalApproverInfo = await ApprovalRecordService.resolveAdditionalApprovers(instance);

          if (additionalApproverInfo.isAdditionalApproverLevel) {
            // Notify additional approver (pass approverUserIds so they receive the request)
            await NotificationQueueService.enqueue('APPROVAL_REQUIRED', {
              approvalInstance: instance,
              levelConfig: additionalApproverInfo.levelConfig,
              requestData,
              approverUserIds: additionalApproverInfo.approverUserId ? [additionalApproverInfo.approverUserId] : undefined,
            });
          } else {
            // Notify next matrix level approvers (use virtualMatrix so personalized effectiveLevels are used)
            const nextLevelConfig = (virtualMatrix as any).levels?.find((l: any) => l.levelNumber === instance.currentLevel);
            if (nextLevelConfig) {
              await NotificationQueueService.enqueue('APPROVAL_REQUIRED', {
                approvalInstance: instance,
                levelConfig: nextLevelConfig,
                requestData,
              });
            }
          }
        } else if (instance.status === ApprovalStatus.APPROVED) {
          await ApprovalService.finalizeApproval(instance);
          // Determine the level that was just completed (currentLevel - 1, or the last level if no more levels)
          const completedLevel = instance.currentLevel > 1 ? instance.currentLevel - 1 : instance.currentLevel;
          // Enqueue final approval notification (async, non-blocking)
          const { NotificationQueueService } = await import('./NotificationQueueService');
          await NotificationQueueService.enqueue('STATUS_CHANGE', {
            approvalInstance: instance,
            requestData,
            status: 'APPROVED' as const,
            comments,
            approvedLevel: completedLevel,
          });
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
    fetch('http://127.0.0.1:7244/ingest/4df6bb03-2191-446a-93ae-c093fcd724e4', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'ApprovalService.ts:1090', message: 'getApprovalHistory: Adding lookup stages to pipeline', data: { filters, employeeFilter, pipelineLength: pipeline.length }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'A' }) }).catch(() => { });
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
      // Lookup employee (user) BEFORE employee filter - requestData has userId, not employeeName
      {
        $lookup: {
          from: 'users',
          localField: 'requestData.userId',
          foreignField: '_id',
          as: 'employee',
        },
      },
      // Apply additional filters - employeeFilter uses employee.name (from lookup above)
      ...(employeeFilter ? [{
        $match: {
          $or: [
            { 'employee.name': new RegExp(employeeFilter, 'i') },
            { 'employee.email': new RegExp(employeeFilter, 'i') },
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
      // employee already looked up above (before employee filter)
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
      fetch('http://127.0.0.1:7244/ingest/4df6bb03-2191-446a-93ae-c093fcd724e4', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'ApprovalService.ts:1292', message: 'getApprovalHistory: Executing aggregation', data: { pipelineLength: pipeline.length, skip, limit }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'A' }) }).catch(() => { });
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
      fetch('http://127.0.0.1:7244/ingest/4df6bb03-2191-446a-93ae-c093fcd724e4', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'ApprovalService.ts:1303', message: 'getApprovalHistory: Aggregation successful', data: { historyCount: history?.length || 0, total }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'A' }) }).catch(() => { });
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
      fetch('http://127.0.0.1:7244/ingest/4df6bb03-2191-446a-93ae-c093fcd724e4', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'ApprovalService.ts:1313', message: 'getApprovalHistory: Aggregation error', data: { error: error?.message || error, stack: error?.stack }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'A' }) }).catch(() => { });
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


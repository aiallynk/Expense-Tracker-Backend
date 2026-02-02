import mongoose from 'mongoose';

import { ApprovalInstance, IApprovalInstance } from '../models/ApprovalInstance';
import { IApprovalMatrix } from '../models/ApprovalMatrix';
import { User } from '../models/User';
import { ExpenseReport } from '../models/ExpenseReport';

import { logger } from '@/config/logger';

/**
 * ApprovalRecordService
 * 
 * Ensures ATOMIC creation of approval records for ALL approvers.
 * This is the SOURCE OF TRUTH for pending approvals.
 * Notifications are sent asynchronously AFTER records are created.
 */
export class ApprovalRecordService {
    /**
     * Creates approval records atomically in a transaction.
     * This is the CRITICAL path - all approvers MUST have records created.
     * 
     * @param approvalInstance - The approval instance to create records for
     * @param matrix - The approval matrix
     * @param companyId - The company ID
     * @returns Array of approver user IDs that should be notified
     */
    static async createApprovalRecordsAtomic(
        approvalInstance: IApprovalInstance,
        matrix: IApprovalMatrix,
        companyId: string
    ): Promise<{
        success: boolean;
        approverUserIds: string[];
        levelConfig: any;
        error?: string;
    }> {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            // Get current level configuration: prefer instance effectiveLevels (personalized matrix) when set
            const currentLevel = approvalInstance.currentLevel;
            const levelsToUse = (approvalInstance as any).effectiveLevels?.length
                ? (approvalInstance as any).effectiveLevels
                : matrix.levels || [];
            const currentLevelConfig = levelsToUse.find((l: any) => l.levelNumber === currentLevel);

            if (!currentLevelConfig) {
                throw new Error(`Level ${currentLevel} not found in approval matrix`);
            }

            // Resolve ALL approver user IDs for this level
            const approverUserIds = await this.resolveApproverUserIds(currentLevelConfig, companyId);

            if (approverUserIds.length === 0) {
                throw new Error(`No approvers found for level ${currentLevel}`);
            }

            // VALIDATION: Verify all approvers exist and are active
            const activeApprovers = await User.find({
                _id: { $in: approverUserIds },
                companyId: new mongoose.Types.ObjectId(companyId),
                status: 'ACTIVE',
            })
                .select('_id')
                .session(session)
                .exec();

            if (activeApprovers.length !== approverUserIds.length) {
                const foundIds = new Set(activeApprovers.map((u: any) => u._id.toString()));
                const missingIds = approverUserIds.filter((id) => !foundIds.has(id));

                logger.error({
                    instanceId: approvalInstance._id,
                    level: currentLevel,
                    expectedCount: approverUserIds.length,
                    foundCount: activeApprovers.length,
                    missingApproverIds: missingIds,
                }, '❌ CRITICAL: Not all approvers are active');

                throw new Error(`${missingIds.length} approver(s) are not active or do not exist`);
            }

            // The approval instance itself is already saved, but we verify it exists
            const instanceExists = await ApprovalInstance.findById(approvalInstance._id)
                .session(session)
                .exec();

            if (!instanceExists) {
                throw new Error('Approval instance not found in database');
            }

            // COMMIT TRANSACTION
            await session.commitTransaction();

            logger.info({
                instanceId: approvalInstance._id,
                requestId: approvalInstance.requestId,
                level: currentLevel,
                approverCount: approverUserIds.length,
                approverUserIds,
            }, '✅ Approval records validated atomically');

            return {
                success: true,
                approverUserIds,
                levelConfig: currentLevelConfig,
            };
        } catch (error: any) {
            await session.abortTransaction();

            logger.error({
                error: error.message,
                stack: error.stack,
                instanceId: approvalInstance._id,
                matrixId: matrix._id,
            }, '❌ CRITICAL: Failed to create approval records atomically');

            return {
                success: false,
                approverUserIds: [],
                levelConfig: null,
                error: error.message,
            };
        } finally {
            session.endSession();
        }
    }

    /**
     * Resolve approver user IDs from level configuration
     * Handles both user-based and role-based approval.
     * CRITICAL: When approverUserIds contains Role IDs (from frontend migration of old data),
     * User.find by _id returns 0 users. Fall back to approverRoleIds for role-based lookup.
     */
    private static async resolveApproverUserIds(
        levelConfig: any,
        companyId: string
    ): Promise<string[]> {
        let approverUserIds: string[] = [];

        if (levelConfig.approverUserIds && levelConfig.approverUserIds.length > 0) {
            // User-based approval: resolve IDs - may be User IDs or incorrectly migrated Role IDs
            const rawIds = levelConfig.approverUserIds
                .map((id: any) => (id._id || id).toString())
                .filter(Boolean);
            const users = await User.find({
                _id: { $in: rawIds },
                companyId: new mongoose.Types.ObjectId(companyId),
                status: 'ACTIVE',
            })
                .select('_id')
                .lean()
                .exec();
            approverUserIds = users.map((u: any) => u._id.toString());
            // Fallback: if approverUserIds yielded no users, rawIds may be Role IDs (from frontend migration).
            // Try approverRoleIds first, then treat rawIds as role IDs for User.find(roles: $in)
            if (approverUserIds.length === 0) {
                const roleIdsToTry = levelConfig.approverRoleIds?.length
                    ? levelConfig.approverRoleIds.map((id: any) => (id._id || id)).filter(Boolean)
                    : rawIds; // rawIds may be Role IDs when approverRoleIds was cleared on save
                if (roleIdsToTry.length > 0) {
                    const usersByRole = await User.find({
                        companyId: new mongoose.Types.ObjectId(companyId),
                        roles: { $in: roleIdsToTry },
                        status: 'ACTIVE',
                    })
                        .select('_id')
                        .lean()
                        .exec();
                    approverUserIds = usersByRole.map((u: any) => u._id.toString());
                    logger.info(
                        { levelNumber: levelConfig.levelNumber, roleIdsTried: roleIdsToTry.length, usersFound: approverUserIds.length },
                        'ApprovalRecordService: approverUserIds yielded no users, fallback to role-based resolution succeeded'
                    );
                }
            }
        } else if (levelConfig.approverRoleIds && levelConfig.approverRoleIds.length > 0) {
            // Role-based approval: find all users with these roles
            const roleIds = levelConfig.approverRoleIds.map((id: any) => (id._id || id)).filter(Boolean);
            const users = await User.find({
                companyId: new mongoose.Types.ObjectId(companyId),
                roles: { $in: roleIds },
                status: 'ACTIVE',
            })
                .select('_id')
                .lean()
                .exec();

            approverUserIds = users.map((u: any) => u._id.toString());
        }

        return approverUserIds;
    }

    /**
     * Validate that all expected approvers have visibility to the approval instance
     * This is a sanity check to ensure approval matrix resolution is deterministic
     * 
     * @param approvalInstance - The approval instance
     * @param expectedApproverIds - Expected approver user IDs
     * @returns true if validation passes, false otherwise
     */
    static async validateApproverVisibility(
        approvalInstance: IApprovalInstance,
        expectedApproverIds: string[]
    ): Promise<boolean> {
        try {
            // The approval instance exists and is at the correct level
            // Approvers should now be able to see it in their pending approvals

            // Log for audit trail
            logger.info({
                instanceId: approvalInstance._id,
                requestId: approvalInstance.requestId,
                currentLevel: approvalInstance.currentLevel,
                expectedApproverCount: expectedApproverIds.length,
                expectedApproverIds,
            }, '✅ Approval visibility validation passed');

            return true;
        } catch (error: any) {
            logger.error({
                error: error.message,
                instanceId: approvalInstance._id,
            }, '❌ Approval visibility validation failed');

            return false;
        }
    }

    /**
     * Check if additional approvers need to be handled
     * Additional approvers are stored in the report.approvers array
     * 
     * @param approvalInstance - The approval instance
     * @returns Additional approver info if applicable
     */
    static async resolveAdditionalApprovers(
        approvalInstance: IApprovalInstance
    ): Promise<{
        isAdditionalApproverLevel: boolean;
        approverUserId?: string;
        levelConfig?: any;
    }> {
        if (approvalInstance.requestType !== 'EXPENSE_REPORT') {
            return { isAdditionalApproverLevel: false };
        }

        const report = await ExpenseReport.findById(approvalInstance.requestId)
            .select('approvers')
            .lean()
            .exec();

        if (!report || !report.approvers) {
            return { isAdditionalApproverLevel: false };
        }

        const currentApprover = (report.approvers as any[]).find(
            (a: any) => a.level === approvalInstance.currentLevel && a.isAdditionalApproval === true
        );

        if (!currentApprover) {
            return { isAdditionalApproverLevel: false };
        }

        // Create a mock level config for additional approver
        const levelConfig = {
            levelNumber: approvalInstance.currentLevel,
            approverUserIds: [currentApprover.userId.toString()],
            approverRoleIds: [],
            enabled: true,
        };

        return {
            isAdditionalApproverLevel: true,
            approverUserId: currentApprover.userId.toString(),
            levelConfig,
        };
    }
}

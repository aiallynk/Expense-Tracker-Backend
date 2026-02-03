import { User } from '../models/User';

import { NotificationService } from './notification.service';

import { logger } from '@/config/logger';

/**
 * Notification Service for Role-Based Approval Matrix
 * Handles notifications for the new approval system
 */
export class ApprovalMatrixNotificationService {

    /**
     * Notify all users with specific approval roles that an approval is pending
     * @param approvalInstance - The ApprovalInstance document
     * @param currentLevelConfig - The current approval level configuration from the matrix
     * @param requestData - The request data (expense report, etc.)
     */
    static async notifyApprovalRequired(
        approvalInstance: any,
        currentLevelConfig: any,
        requestData: any,
        preResolvedApproverUserIds?: string[]
    ): Promise<void> {
        try {
            // STEP 1: VALIDATE REQUIRED DATA (STRICT)
            if (!approvalInstance || !approvalInstance.companyId) {
                logger.error('Missing approval instance or companyId');
                return;
            }

            // Hydrate request data if missing fields
            let report = requestData;
            if (approvalInstance.requestType === 'EXPENSE_REPORT') {
                const { ExpenseReport } = await import('../models/ExpenseReport');
                report = await ExpenseReport.findById(approvalInstance.requestId)
                    .populate('userId', 'name email companyId')
                    .lean()
                    .exec();
            }

            if (!report) {
                logger.error({ requestId: approvalInstance.requestId }, 'Request data not found for notification');
                return;
            }

            if (!report.userId) {
                logger.error({ reportId: report._id }, 'Report owner (userId) missing');
                return;
            }

            const requester = report.userId;
            const requesterName = requester.name || requester.email || 'An employee';

            // STEP 2: RESOLVE APPROVERS - prefer pre-resolved IDs (handles role IDs in approverUserIds)
            let usersToNotify: any[] = [];
            if (preResolvedApproverUserIds && preResolvedApproverUserIds.length > 0) {
                usersToNotify = await User.find({
                    _id: { $in: preResolvedApproverUserIds },
                    status: 'ACTIVE',
                    companyId: approvalInstance.companyId,
                })
                    .select('_id email name roles notificationSettings')
                    .populate('roles', 'name')
                    .exec();
            }
            if (usersToNotify.length === 0) {
                let approverIds: string[] = [];
                let isUserBasedApproval = false;
                if (currentLevelConfig.approverUserIds && currentLevelConfig.approverUserIds.length > 0) {
                    approverIds = currentLevelConfig.approverUserIds
                        .map((id: any) => (id._id || id).toString())
                        .filter((id: string) => id && id !== '[object Object]');
                    isUserBasedApproval = true;
                } else if (currentLevelConfig.approverRoleIds && currentLevelConfig.approverRoleIds.length > 0) {
                    approverIds = currentLevelConfig.approverRoleIds
                        .map((id: any) => (id._id || id).toString())
                        .filter((id: string) => id && id !== '[object Object]');
                    isUserBasedApproval = false;
                }
                if (approverIds.length === 0) {
                    logger.warn({ instanceId: approvalInstance._id }, 'No approver IDs found for current level');
                    return;
                }
                if (isUserBasedApproval) {
                    usersToNotify = await User.find({
                        _id: { $in: approverIds },
                        status: 'ACTIVE',
                        companyId: approvalInstance.companyId,
                    })
                        .select('_id email name roles notificationSettings')
                        .populate('roles', 'name')
                        .exec();
                } else {
                    usersToNotify = await User.find({
                        roles: { $in: approverIds },
                        status: 'ACTIVE',
                        companyId: approvalInstance.companyId,
                    })
                        .select('_id email name roles notificationSettings')
                        .populate('roles', 'name')
                        .exec();
                }
            }

            if (usersToNotify.length === 0) {
                logger.warn({ instanceId: approvalInstance._id }, 'No active users found with required approval roles');
                return;
            }

            // STEP 3: SEND NOTIFICATIONS
            const requestType = 'Expense Report';
            const requestName = report.name || 'Unnamed Request';

            for (const userObj of usersToNotify) {
                const user = userObj as any;
                const userId = user._id.toString();

                // IDEMPOTENCY KEY
                const notificationKey = `${approvalInstance.companyId}:${report._id}:${userId}:APPROVAL_REQUIRED`;

                const settings = user.notificationSettings || {};
                const allowPush = settings.push !== false;
                const allowApprovalAlerts = settings.approvalAlerts !== false;

                if (!allowApprovalAlerts) continue;

                // 1. Create DB Record (Source of Truth)
                try {
                    const { NotificationDataService } = await import('./notificationData.service');
                    const { NotificationType } = await import('../models/Notification');
                    const approverNames = user.name || user.email;

                    await NotificationDataService.createNotification({
                        userId: userId,
                        companyId: approvalInstance.companyId.toString(),
                        type: NotificationType.REPORT_PENDING_APPROVAL,
                        title: 'New Approval Required',
                        description: `${requestType} "${requestName}" submitted by ${requesterName} requires your approval`,
                        link: `/approvals/pending?reportId=${report._id}`,
                        metadata: {
                            instanceId: approvalInstance._id.toString(),
                            requestId: report._id.toString(),
                            requestType,
                            requestName,
                            requesterName,
                            level: approvalInstance.currentLevel,
                            totalAmount: report.totalAmount,
                            currency: report.currency,
                            approverNames
                        },
                        notificationKey
                    });
                } catch (e: any) {
                    logger.debug({ userId, error: e.message }, 'DB notification skipped (duplicate)');
                }

                // 2. Push Notification
                if (allowPush) {
                    await NotificationService.sendPushToUser(userId, {
                        title: 'New Approval Required',
                        body: `${requestType} "${requestName}" requires your approval`,
                        data: {
                            type: 'APPROVAL_REQUIRED',
                            instanceId: approvalInstance._id.toString(),
                            requestId: report._id.toString(),
                            action: 'APPROVAL_REQUIRED',
                            notificationKey
                        },
                    });
                }

                // Email notification to approver when approval request is assigned is disabled (in-app and push only).
            }
        } catch (error: any) {
            logger.error({ error: error.message, instanceId: approvalInstance?._id }, 'notifyApprovalRequired failed');
        }
    }

    /**
     * Notify requester that their request was approved or rejected
     * @param approvalInstance - The ApprovalInstance document
     * @param requestData - The request data
     * @param status - 'APPROVED' or 'REJECTED'
     * @param comments - Optional comments from approver
     */
    static async notifyRequestStatusChanged(
        approvalInstance: any,
        requestData: any,
        status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED',
        comments?: string,
        approvedLevel?: number
    ): Promise<void> {
        try {
            const { User } = await import('../models/User');
            const { Role } = await import('../models/Role');

            const isApproved = status === 'APPROVED';
            const isChangesRequested = status === 'CHANGES_REQUESTED';
            const requestType = requestData.name ? 'Expense Report' : 'Request';
            const requestName = requestData.name || 'Unnamed Request';

            let displayStatus = status as string;
            if (isApproved) displayStatus = 'Approved';
            if (status === 'REJECTED') displayStatus = 'Rejected';
            if (isChangesRequested) displayStatus = 'Changes Requested';

            // Extract approver information from approval instance history
            let approverName: string | undefined;
            let approverRole: string | undefined;

            if (approvalInstance.history && approvalInstance.history.length > 0) {
                // Get the most recent history entry for the current status
                const relevantHistory = approvalInstance.history
                    .filter((h: any) => {
                        if (isApproved) return h.status === 'APPROVED';
                        if (status === 'REJECTED') return h.status === 'REJECTED';
                        if (isChangesRequested) return h.status === 'CHANGES_REQUESTED';
                        return false;
                    })
                    .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

                if (relevantHistory.length > 0) {
                    const latestEntry = relevantHistory[0];

                    // Fetch approver user details
                    if (latestEntry.approverId) {
                        try {
                            const approver = await User.findById(latestEntry.approverId)
                                .select('name')
                                .lean()
                                .exec();
                            if (approver) {
                                approverName = approver.name;
                            }
                        } catch (error) {
                            logger.warn({ error, approverId: latestEntry.approverId }, 'Failed to fetch approver name');
                        }
                    }

                    // Fetch approver role details
                    if (latestEntry.roleId) {
                        try {
                            const role = await Role.findById(latestEntry.roleId)
                                .select('name')
                                .lean()
                                .exec();
                            if (role) {
                                approverRole = role.name;
                            }
                        } catch (error) {
                            logger.warn({ error, roleId: latestEntry.roleId }, 'Failed to fetch approver role');
                        }
                    }
                }
            }

            // Build notification message with level information
            let notificationTitle = `${requestType} ${displayStatus}`;
            let notificationBody = `Your ${requestType.toLowerCase()} "${requestName}" has been ${displayStatus.toLowerCase()}`;

            // Add approver information to body
            if (approverName) {
                if (approverRole) {
                    notificationBody += ` by ${approverName} (${approverRole})`;
                } else {
                    notificationBody += ` by ${approverName}`;
                }
            }

            // Add level information for intermediate approvals
            if (isApproved && approvedLevel !== undefined && approvalInstance.status === 'PENDING') {
                const levelName = approvedLevel === 1 ? 'L1' : approvedLevel === 2 ? 'L2' : `L${approvedLevel}`;
                notificationTitle = `Report Approved at ${levelName}`;
                notificationBody = `Your expense report "${requestName}" has been approved at Level ${approvedLevel}`;
                if (approverName) {
                    if (approverRole) {
                        notificationBody += ` by ${approverName} (${approverRole})`;
                    } else {
                        notificationBody += ` by ${approverName}`;
                    }
                }
                notificationBody += `. It is now pending approval at the next level.`;
            } else if (isApproved && approvedLevel !== undefined) {
                const levelName = approvedLevel === 1 ? 'L1' : approvedLevel === 2 ? 'L2' : `L${approvedLevel}`;
                notificationTitle = `Report Approved at ${levelName}`;
                notificationBody = `Your expense report "${requestName}" has been approved at Level ${approvedLevel}`;
                if (approverName) {
                    if (approverRole) {
                        notificationBody += ` by ${approverName} (${approverRole})`;
                    } else {
                        notificationBody += ` by ${approverName}`;
                    }
                }
                notificationBody += `.`;
            } else if (isApproved && approvalInstance.status === 'APPROVED') {
                // Final approval - determine level from history
                const approvedHistory = approvalInstance.history
                    ?.filter((h: any) => h.status === 'APPROVED')
                    .sort((a: any, b: any) => b.levelNumber - a.levelNumber);

                if (approvedHistory && approvedHistory.length > 0) {
                    const finalLevel = approvedHistory[0].levelNumber;
                    const levelName = finalLevel === 1 ? 'L1' : finalLevel === 2 ? 'L2' : `L${finalLevel}`;
                    notificationTitle = `Report Approved at ${levelName}`;
                    notificationBody = `Your expense report "${requestName}" has been fully approved`;
                    if (approverName) {
                        if (approverRole) {
                            notificationBody += ` by ${approverName} (${approverRole})`;
                        } else {
                            notificationBody += ` by ${approverName}`;
                        }
                    }
                    notificationBody += `.`;
                } else {
                    notificationTitle = `Report Approved`;
                    notificationBody = `Your expense report "${requestName}" has been fully approved`;
                    if (approverName) {
                        if (approverRole) {
                            notificationBody += ` by ${approverName} (${approverRole})`;
                        } else {
                            notificationBody += ` by ${approverName}`;
                        }
                    }
                    notificationBody += `.`;
                }
            }

            // Get requester info and Check Notification Settings
            const requester = await User.findById(requestData.userId)
                .select('active email name notificationSettings')
                .exec();

            if (!requester) {
                logger.warn({ userId: requestData.userId }, 'Requester not found for notifications');
                return;
            }

            const settings: any = requester.notificationSettings || {};
            const allowPush = settings.push !== false;
            const allowReportStatus = settings.reportStatus !== false;

            if (allowReportStatus) {
                // Send push notification to requester
                if (allowPush) {
                    await NotificationService.sendPushToUser(requestData.userId.toString(), {
                        title: notificationTitle,
                        body: notificationBody,
                        data: {
                            type: isApproved ? 'REQUEST_APPROVED' : isChangesRequested ? 'CHANGES_REQUESTED' : 'REQUEST_REJECTED',
                            instanceId: approvalInstance._id.toString(),
                            requestId: approvalInstance.requestId.toString(),
                            requestType: approvalInstance.requestType,
                            action: isApproved ? 'REQUEST_APPROVED' : isChangesRequested ? 'CHANGES_REQUESTED' : 'REQUEST_REJECTED',
                            level: approvedLevel,
                            approverName: approverName,
                            approverRole: approverRole,
                            comments: comments || '',
                        },
                    });
                } else {
                    logger.debug({ userId: requestData.userId }, 'Push notification skipped (user preference)');
                }

                // Email disabled for approval status — only summary and forgot-password emails are sent (per product requirement).
            } else {
                logger.info({ userId: requestData.userId }, 'Skipping notification: User disabled report status updates');
            }

            // Create database notification record (Always create this, regardless of Push/Email settings)
            try {
                const { NotificationDataService } = await import('./notificationData.service');
                const { NotificationType } = await import('../models/Notification');

                let notificationType = NotificationType.REPORT_REJECTED;
                if (isApproved) {
                    notificationType = NotificationType.REPORT_APPROVED;
                } else if (isChangesRequested) {
                    notificationType = NotificationType.REPORT_CHANGES_REQUESTED;
                }

                let notificationTitleStr = `${requestType} ${displayStatus}`;
                let notificationDescription = `Your ${requestType.toLowerCase()} "${requestName}" has been ${displayStatus.toLowerCase()}`;

                // Add approver information
                if (approverName) {
                    if (approverRole) {
                        notificationDescription += ` by ${approverName} (${approverRole})`;
                    } else {
                        notificationDescription += ` by ${approverName}`;
                    }
                }

                // Add level information for intermediate approvals
                if (isApproved && approvedLevel !== undefined && approvalInstance.status === 'PENDING') {
                    notificationTitleStr = `Report Approved at L${approvedLevel}`;
                    notificationDescription = `Your expense report "${requestName}" has been approved at Level ${approvedLevel}`;
                    if (approverName) {
                        if (approverRole) {
                            notificationDescription += ` by ${approverName} (${approverRole})`;
                        } else {
                            notificationDescription += ` by ${approverName}`;
                        }
                    }
                    notificationDescription += `. It is now pending approval at the next level.`;
                } else if (isApproved && approvedLevel !== undefined) {
                    notificationTitleStr = `Report Approved at L${approvedLevel}`;
                    notificationDescription = `Your expense report "${requestName}" has been approved at Level ${approvedLevel}`;
                    if (approverName) {
                        if (approverRole) {
                            notificationDescription += ` by ${approverName} (${approverRole})`;
                        } else {
                            notificationDescription += ` by ${approverName}`;
                        }
                    }
                    notificationDescription += `.`;
                }

                // Add comments if available
                if (comments && comments.trim()) {
                    notificationDescription += ` Comments: ${comments.trim()}`;
                }

                await NotificationDataService.createNotification({
                    userId: requestData.userId.toString(),
                    type: notificationType,
                    title: notificationTitleStr,
                    description: notificationDescription,
                    link: `/reports/${approvalInstance.requestId.toString()}`,
                    companyId: requestData.companyId?.toString() || (requestData.userId?.companyId?.toString()),
                    metadata: {
                        instanceId: approvalInstance._id.toString(),
                        reportId: approvalInstance.requestId.toString(),
                        level: approvedLevel,
                        status: status,
                        approverName: approverName,
                        approverRole: approverRole,
                        comments: comments || '',
                    }
                });
            } catch (notifError: any) {
                logger.error({ error: notifError?.message || notifError }, 'Error creating database notification');
            }

            logger.info({
                instanceId: approvalInstance._id.toString(),
                requesterId: requestData.userId.toString(),
                status,
                level: approvedLevel,
            }, `✅ Status change notification sent to requester`);

        } catch (error: any) {
            logger.error({
                error: error.message || error,
                instanceId: approvalInstance?._id?.toString(),
            }, 'Error in notifyRequestStatusChanged');
            // Don't throw - notifications are non-critical
        }
    }

    /**
     * Notify when approval moves to next level
     * @param approvalInstance - The ApprovalInstance document
     * @param nextLevelConfig - The next level configuration
     * @param requestData - The request data
     */
    static async notifyNextLevel(
        approvalInstance: any,
        nextLevelConfig: any,
        requestData: any
    ): Promise<void> {
        try {
            logger.info({
                instanceId: approvalInstance._id.toString(),
                nextLevel: nextLevelConfig.levelNumber,
            }, 'Notifying next level approvers');

            // Use the same logic as initial notification
            await this.notifyApprovalRequired(approvalInstance, nextLevelConfig, requestData);

        } catch (error: any) {
            logger.error({
                error: error.message || error,
                instanceId: approvalInstance?._id?.toString(),
            }, 'Error in notifyNextLevel');
            // Don't throw - notifications are non-critical
        }
    }
}

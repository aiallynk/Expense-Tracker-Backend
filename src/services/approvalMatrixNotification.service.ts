import { Role } from '../models/Role';
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
        requestData: any
    ): Promise<void> {
        try {
            // Get all role IDs for the current level
            const approverRoleIds = currentLevelConfig.approverRoleIds || [];

            if (approverRoleIds.length === 0) {
                logger.warn({ instanceId: approvalInstance._id }, 'No approver roles found for current level');
                return;
            }

            logger.info({
                instanceId: approvalInstance._id,
                currentLevel: approvalInstance.currentLevel,
                roleIds: approverRoleIds.map((r: any) => r.toString()),
            }, 'Sending approval notifications to role holders');

            // Find all roles
            const roles = await Role.find({ _id: { $in: approverRoleIds } })
                .select('name type companyId')
                .exec();

            if (roles.length === 0) {
                logger.warn({ instanceId: approvalInstance._id, roleIds: approverRoleIds }, 'No roles found for approval notification');
                return;
            }

            // Find all users who have any of these roles
            const usersWithRoles = await User.find({
                roles: { $in: approverRoleIds },
                status: 'ACTIVE',
                companyId: approvalInstance.companyId,
            })
                .select('_id email name roles')
                .exec();

            if (usersWithRoles.length === 0) {
                logger.warn({
                    instanceId: approvalInstance._id,
                    roleIds: approverRoleIds.map((r: any) => r.toString()),
                }, 'No active users found with required approval roles');
                return;
            }

            logger.info({
                instanceId: approvalInstance._id,
                usersCount: usersWithRoles.length,
                users: usersWithRoles.map((u: any) => ({ id: u._id.toString(), email: u.email })),
            }, `Found ${usersWithRoles.length} users with required approval roles`);

            // Get role names for display
            const roleNames = roles.map(r => r.name).join(', ');

            // Prepare notification payload
            const requestType = requestData.name ? 'Expense Report' : 'Request';
            const requestName = requestData.name || 'Unnamed Request';

            // Get requester info
            const requester = await User.findById(requestData.userId)
                .select('name email')
                .exec();
            const requesterName = requester?.name || requester?.email || 'An employee';

            // Send notifications to each user
            for (const userObj of usersWithRoles) {
                const user = userObj as any;
                try {
                    // 1. Send Push Notification
                    await NotificationService.sendPushToUser(user._id.toString(), {
                        title: 'New Approval Required',
                        body: `${requestType} "${requestName}" requires your approval`,
                        data: {
                            type: 'APPROVAL_REQUIRED',
                            instanceId: approvalInstance._id.toString(),
                            requestId: approvalInstance.requestId.toString(),
                            requestType: approvalInstance.requestType,
                            action: 'APPROVAL_REQUIRED',
                            companyId: approvalInstance.companyId.toString(),
                            level: approvalInstance.currentLevel.toString(),
                        },
                    });
                    logger.debug({ userId: user._id.toString() }, '✅ Push notification sent');

                    // 2. Create Database Notification Record (for UI inbox)
                    const { NotificationDataService } = await import('./notificationData.service');
                    const { NotificationType } = await import('../models/Notification');

                    await NotificationDataService.createNotification({
                        userId: user._id.toString(),
                        companyId: approvalInstance.companyId.toString(),
                        type: NotificationType.REPORT_PENDING_APPROVAL,
                        title: 'New Approval Required',
                        description: `${requestType} "${requestName}" submitted by ${requesterName} requires your approval (as ${roleNames})`,
                        link: `/approvals`, // Unified approval inbox
                        metadata: {
                            instanceId: approvalInstance._id.toString(),
                            requestId: approvalInstance.requestId.toString(),
                            requestType: approvalInstance.requestType,
                            requestName,
                            requesterId: requestData.userId.toString(),
                            requesterName,
                            level: approvalInstance.currentLevel,
                            roleNames,
                        },
                    });
                    logger.debug({ userId: user._id.toString() }, '✅ Database notification created');

                    // 3. Send Email Notification
                    if (user.email) {
                        await NotificationService.sendEmail({
                            to: user.email,
                            subject: `New Approval Required: ${requestName}`,
                            template: 'approval_required',
                            data: {
                                requestType,
                                requestName,
                                requesterName,
                                level: approvalInstance.currentLevel,
                                roleNames,
                                instanceId: approvalInstance._id.toString(),
                            },
                        });
                        logger.debug({ userId: user._id.toString(), email: user.email }, '✅ Email notification sent');
                    }
                } catch (error: any) {
                    logger.error({
                        error: error.message || error,
                        userId: user._id.toString(),
                        instanceId: approvalInstance._id.toString(),
                    }, 'Error sending notification to user');
                    // Continue with other users even if one fails
                }
            }

            logger.info({
                instanceId: approvalInstance._id,
                notifiedUsers: usersWithRoles.length,
                roles: roleNames,
            }, `✅ Approval notifications sent to ${usersWithRoles.length} users`);

        } catch (error: any) {
            logger.error({
                error: error.message || error,
                instanceId: approvalInstance?._id?.toString(),
            }, 'Error in notifyApprovalRequired');
            // Don't throw - notifications are non-critical
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
        comments?: string
    ): Promise<void> {
        try {
            const isApproved = status === 'APPROVED';
            const isChangesRequested = status === 'CHANGES_REQUESTED';
            const requestType = requestData.name ? 'Expense Report' : 'Request';
            const requestName = requestData.name || 'Unnamed Request';

            let displayStatus = status as string;
            if (isApproved) displayStatus = 'Approved';
            if (status === 'REJECTED') displayStatus = 'Rejected';
            if (isChangesRequested) displayStatus = 'Changes Requested';

            // Send push notification to requester
            await NotificationService.sendPushToUser(requestData.userId.toString(), {
                title: `${requestType} ${displayStatus}`,
                body: `Your ${requestType.toLowerCase()} "${requestName}" has been ${displayStatus.toLowerCase()}`,
                data: {
                    type: isApproved ? 'REQUEST_APPROVED' : isChangesRequested ? 'CHANGES_REQUESTED' : 'REQUEST_REJECTED',
                    instanceId: approvalInstance._id.toString(),
                    requestId: approvalInstance.requestId.toString(),
                    requestType: approvalInstance.requestType,
                    action: isApproved ? 'REQUEST_APPROVED' : isChangesRequested ? 'CHANGES_REQUESTED' : 'REQUEST_REJECTED',
                },
            });

            // Get requester info for email
            const requester = await User.findById(requestData.userId)
                .select('email name')
                .exec();

            if (requester?.email) {
                let template = 'request_rejected';
                if (isApproved) template = 'request_approved';
                if (isChangesRequested) template = 'report_changes_requested';

                await NotificationService.sendEmail({
                    to: requester.email,
                    subject: `${requestType} ${displayStatus}: ${requestName}`,
                    template,
                    data: {
                        requestType,
                        requestName,
                        reportName: requestName, // Some templates use reportName
                        status: displayStatus,
                        comments: comments || '',
                        instanceId: approvalInstance._id.toString(),
                    },
                });
            }

            logger.info({
                instanceId: approvalInstance._id.toString(),
                requesterId: requestData.userId.toString(),
                status,
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

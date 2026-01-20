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

            // Send push notification to requester
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

            // Create database notification record
            try {
                const { NotificationDataService } = await import('./notificationData.service');
                const { NotificationType } = await import('../models/Notification');
                
                let notificationType = NotificationType.REPORT_REJECTED;
                if (isApproved) {
                    notificationType = NotificationType.REPORT_APPROVED;
                } else if (isChangesRequested) {
                    notificationType = NotificationType.REPORT_CHANGES_REQUESTED;
                }
                
                let notificationTitle = `${requestType} ${displayStatus}`;
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
                    notificationTitle = `Report Approved at L${approvedLevel}`;
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
                    notificationTitle = `Report Approved at L${approvedLevel}`;
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
                    title: notificationTitle,
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

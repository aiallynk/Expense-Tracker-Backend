import mongoose from 'mongoose';

import { getMessaging } from '../config/firebase';
import { getResendClient, getFromEmail } from '../config/resend';
import { config } from '../config/index';
import { NotificationToken } from '../models/NotificationToken';
import { User } from '../models/User';
// import { ExpenseReport } from '../models/ExpenseReport'; // Unused
import { NotificationPlatform, ExpenseReportStatus } from '../utils/enums';
import { getAllUsersTopic, getCompanyTopic, getRoleTopic } from '../utils/topicUtils';

import { logger } from '@/config/logger';


export class NotificationService {
  static async registerFcmToken(
    userId: string,
    token: string,
    platform: NotificationPlatform
  ): Promise<void> {
    // Remove existing token if exists (by fcmToken or token field)
    await NotificationToken.findOneAndDelete({
      $or: [
        { fcmToken: token },
        { token }
      ]
    });

    // Create or update user's token
    await NotificationToken.findOneAndUpdate(
      { userId, platform },
      {
        userId,
        token,
        fcmToken: token,
        platform,
      },
      { upsert: true, new: true }
    );

    // Subscribe token to FCM topics (async, don't block registration)
    this.subscribeTokenToTopics(userId, token).catch((error) => {
      // Log but don't fail registration if topic subscription fails
      logger.warn({ error: error.message || error, userId }, 'Failed to subscribe token to topics, but token registration succeeded');
    });
  }

  /**
   * Subscribe FCM token to relevant topics
   * - all_users (all users)
   * - company_<companyId> (if user has company)
   * - role_<USER_ROLE> (based on user's role)
   */
  static async subscribeTokenToTopics(userId: string, token: string): Promise<void> {
    const messaging = getMessaging();
    if (!messaging) {
      logger.debug('Firebase not configured - skipping topic subscription');
      return;
    }

    try {
      // Get user to check companyId and role
      const user = await User.findById(userId).select('companyId role').exec();
      if (!user) {
        logger.warn(`User ${userId} not found for topic subscription`);
        return;
      }

      const topics: string[] = [];

      // Always subscribe to all_users topic
      topics.push(getAllUsersTopic());

      // Subscribe to company topic if user has companyId
      if (user.companyId) {
        try {
          const companyTopic = getCompanyTopic(user.companyId.toString());
          topics.push(companyTopic);
        } catch (error: any) {
          logger.warn({ error: error.message || error, userId, companyId: user.companyId }, 'Failed to generate company topic name');
        }
      }

      // Subscribe to role-based topic
      if (user.role) {
        try {
          const roleTopic = getRoleTopic(user.role);
          topics.push(roleTopic);
          logger.debug(`Subscribing token to role topic: ${roleTopic} for user ${userId} with role ${user.role}`);
        } catch (error: any) {
          logger.warn({ error: error.message || error, userId, role: user.role }, 'Failed to generate role topic name');
        }
      }

      // Subscribe to all topics
      for (const topic of topics) {
        try {
          await messaging.subscribeToTopic([token], topic);
          logger.info(`✅ Subscribed token to topic: ${topic} for user ${userId}`);
        } catch (error: any) {
          // Log but continue with other topics
          logger.warn({ error: error.message || error, topic, userId }, `Failed to subscribe to topic ${topic}`);
        }
      }

      logger.info(`Topic subscription completed for user ${userId}, subscribed to ${topics.length} topic(s): ${topics.join(', ')}`);
    } catch (error: any) {
      logger.error({ error: error.message || error, userId }, 'Error in subscribeTokenToTopics');
      throw error;
    }
  }

  static async sendPushToAllUsers(
    payload: {
      title: string;
      body: string;
      data?: Record<string, any>;
    }
  ): Promise<{ successCount: number; failureCount: number; totalUsers: number }> {
    try {
      // Fetch all users with FCM tokens
      const tokens = await NotificationToken.find({ fcmToken: { $exists: true, $ne: null } })
        .select('userId fcmToken')
        .exec();

      if (tokens.length === 0) {
        logger.debug('No FCM tokens found for any users');
        return { successCount: 0, failureCount: 0, totalUsers: 0 };
      }

      // Group tokens by userId to avoid duplicates
      const userTokensMap = new Map<string, string[]>();
      for (const tokenDoc of tokens) {
        const userId = tokenDoc.userId.toString();
        if (!userTokensMap.has(userId)) {
          userTokensMap.set(userId, []);
        }
        if (tokenDoc.fcmToken) {
          userTokensMap.get(userId)!.push(tokenDoc.fcmToken);
        }
      }

      const messaging = getMessaging();
      if (!messaging) {
        logger.debug('Firebase not configured - push notification skipped');
        return { successCount: 0, failureCount: 0, totalUsers: userTokensMap.size };
      }

      // Ensure all data values are strings (FCM requirement)
      const dataPayload: Record<string, string> = {};
      if (payload.data) {
        for (const [key, value] of Object.entries(payload.data)) {
          dataPayload[key] = String(value);
        }
      }

      let totalSuccess = 0;
      let totalFailure = 0;

      // Send to each user's devices
      for (const [userId, fcmTokens] of userTokensMap.entries()) {
        if (fcmTokens.length === 0) continue;

        try {
          const message = {
            notification: {
              title: payload.title,
              body: payload.body,
            },
            data: dataPayload,
            tokens: fcmTokens,
          };

          const response = await messaging.sendEachForMulticast(message);
          totalSuccess += response.successCount;
          totalFailure += response.failureCount;

          // Handle invalid tokens
          if (response.failureCount > 0) {
            const invalidTokens: string[] = [];
            response.responses.forEach((resp, idx) => {
              if (!resp.success) {
                const errorCode = resp.error?.code;
                if (errorCode === 'messaging/registration-token-not-registered' ||
                  errorCode === 'messaging/invalid-registration-token') {
                  invalidTokens.push(fcmTokens[idx]);
                }
              }
            });

            if (invalidTokens.length > 0) {
              await NotificationToken.deleteMany({ fcmToken: { $in: invalidTokens } });
              logger.info(`Removed ${invalidTokens.length} invalid FCM tokens for user ${userId}`);
            }
          }
        } catch (error: any) {
          logger.error({ error: error.message || error, userId }, 'Error sending push notification to user');
          totalFailure += fcmTokens.length;
        }
      }

      logger.info(`Push notification sent to ${totalSuccess} devices across ${userTokensMap.size} users`);
      return { successCount: totalSuccess, failureCount: totalFailure, totalUsers: userTokensMap.size };
    } catch (error: any) {
      logger.error({ error: error.message || error }, 'Error in sendPushToAllUsers');
      return { successCount: 0, failureCount: 0, totalUsers: 0 };
    }
  }

  /**
   * Send broadcast notification to a Firebase FCM topic
   * This is scalable and doesn't require looping through users
   * @param payload - Notification payload
   * @param topic - FCM topic name (e.g., "all_users", "company_123")
   * @returns Message ID from Firebase
   */
  static async sendBroadcastToTopic(
    payload: {
      title: string;
      body: string;
      data?: Record<string, any>;
    },
    topic: string
  ): Promise<string> {
    const messaging = getMessaging();
    if (!messaging) {
      logger.debug('Firebase not configured - broadcast notification skipped');
      throw new Error('Firebase not configured');
    }

    // Ensure all data values are strings (FCM requirement)
    const dataPayload: Record<string, string> = {};
    if (payload.data) {
      for (const [key, value] of Object.entries(payload.data)) {
        dataPayload[key] = String(value);
      }
    }

    try {
      const message: any = {
        topic,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: dataPayload,
        // Android-specific configuration
        android: {
          priority: 'high' as const,
          notification: {
            channelId: 'nexpense_notifications', // Must match AndroidManifest.xml
            sound: 'default',
            priority: 'high' as const,
            defaultSound: true,
            defaultVibrateTimings: true,
            defaultLightSettings: true,
          },
        },
        // APNS (iOS) configuration (optional, but good practice)
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      const messageId = await messaging.send(message);
      logger.info(`Broadcast notification sent to topic "${topic}", messageId: ${messageId}`);
      logger.debug(`Notification payload: ${JSON.stringify({ title: payload.title, body: payload.body, topic, hasData: !!payload.data })}`);
      return messageId;
    } catch (error: any) {
      logger.error({ error: error.message || error, topic }, 'Failed to send broadcast notification to topic');
      throw error;
    }
  }

  static async sendPushToUser(
    userId: string,
    payload: {
      title: string;
      body: string;
      data?: Record<string, any>;
    }
  ): Promise<void> {
    try {
      // Get user to verify company isolation
      const user = await User.findById(userId).select('companyId').exec();
      if (!user) {
        logger.debug(`User ${userId} not found, skipping notification`);
        return;
      }

      // Find tokens for this user (handle both string and ObjectId)
      const userIdQuery = typeof userId === 'string'
        ? new mongoose.Types.ObjectId(userId)
        : userId;

      const tokens = await NotificationToken.find({ userId: userIdQuery }).select('fcmToken platform token').exec();

      if (tokens.length === 0) {
        logger.warn({ userId, userIdQuery }, `No FCM tokens found for user - user may not have registered notification token`);
        return;
      }

      logger.info({ userId, tokenCount: tokens.length }, `Found ${tokens.length} FCM token(s) for user`);

      // Filter tokens by company if user has a company
      // Note: We assume tokens are registered by authenticated users from same company
      // Additional validation can be added if needed
      const fcmTokens = tokens
        .map((t) => t.fcmToken)
        .filter((t): t is string => t !== undefined && t !== null);

      if (fcmTokens.length === 0) {
        logger.debug(`No valid FCM tokens found for user ${userId}`);
        return;
      }

      const messaging = getMessaging();

      if (!messaging) {
        logger.debug('Firebase not configured - push notification skipped');
        return;
      }

      // Ensure all data values are strings (FCM requirement)
      const dataPayload: Record<string, string> = {};
      if (payload.data) {
        for (const [key, value] of Object.entries(payload.data)) {
          dataPayload[key] = String(value);
        }
      }

      const message: any = {
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: dataPayload,
        tokens: fcmTokens,
        // Android-specific configuration
        android: {
          priority: 'high' as const,
          notification: {
            channelId: 'nexpense_notifications', // Must match AndroidManifest.xml
            sound: 'default',
            priority: 'high' as const,
            defaultSound: true,
            defaultVibrateTimings: true,
            defaultLightSettings: true,
          },
        },
        // APNS (iOS) configuration (optional, but good practice)
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      const response = await messaging.sendEachForMulticast(message);

      // Handle invalid tokens
      if (response.failureCount > 0) {
        const invalidTokens: string[] = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errorCode = resp.error?.code;
            if (errorCode === 'messaging/registration-token-not-registered' ||
              errorCode === 'messaging/invalid-registration-token') {
              invalidTokens.push(fcmTokens[idx]);
            }
          }
        });

        // Remove invalid tokens from database
        if (invalidTokens.length > 0) {
          await NotificationToken.deleteMany({ fcmToken: { $in: invalidTokens } });
          logger.info(`Removed ${invalidTokens.length} invalid FCM tokens`);
        }
      }

      logger.info(`Push notification sent to ${response.successCount} devices for user ${userId}`);
    } catch (error: any) {
      logger.error({ error: error.message || error }, 'Error sending push notification');
      // Don't throw - notifications are non-critical
    }
  }

  static async notifyReportSubmitted(report: any): Promise<void> {
    // Notify Level 1 approvers (managers) using role-based topic
    if (!report.approvers || report.approvers.length === 0) {
      logger.warn({ reportId: report._id }, 'No approvers found for report, skipping notification');
      return;
    }

    logger.info({
      reportId: report._id,
      approversCount: report.approvers.length,
      approvers: report.approvers.map((a: any) => ({
        level: a.level,
        userId: a.userId?.toString(),
        role: a.role,
        decidedAt: a.decidedAt
      }))
    }, 'Processing notifications for report submission');

    // Get Level 1 approvers (managers) for DB records and emails
    const level1Approvers = report.approvers.filter(
      (approver: any) => approver.level === 1 && !approver.decidedAt
    );

    if (level1Approvers.length === 0) {
      logger.warn({ reportId: report._id }, 'No Level 1 approvers found for report (or all have decided)');
      return;
    }

    // Get report owner for context
    const reportOwner = await User.findById(report.userId).select('name email companyId').exec();
    if (!reportOwner) {
      logger.warn({ reportId: report._id }, 'Report owner not found, skipping notification');
      return;
    }

    // Send broadcast notification to role_MANAGER topic (Firebase FCM)
    try {
      const managerTopic = getRoleTopic('MANAGER');
      const messageId = await this.sendBroadcastToTopic(
        {
          title: 'New Expense Report Submitted',
          body: `Report "${report.name}" has been submitted for your approval`,
          data: {
            type: 'REPORT_SUBMITTED',
            reportId: report._id.toString(),
            action: 'REPORT_SUBMITTED',
            companyId: reportOwner.companyId?.toString() || '',
          },
        },
        managerTopic
      );
      logger.info({ reportId: report._id, topic: managerTopic, messageId }, '✅ Broadcast notification sent to role_MANAGER topic');
    } catch (error: any) {
      logger.error({ error: error.message || error, reportId: report._id }, '❌ Failed to send broadcast notification to role_MANAGER topic');
      // Continue to create DB records even if FCM fails
    }

    // Create DB notification records for all Level 1 approvers (for UI display)
    const { NotificationDataService } = await import('./notificationData.service');
    const { NotificationType } = await import('../models/Notification');

    for (const approver of level1Approvers) {
      const approverUserId = approver.userId;
      let approverId: string;

      if (typeof approverUserId === 'string') {
        approverId = approverUserId;
      } else if (approverUserId && typeof approverUserId.toString === 'function') {
        approverId = approverUserId.toString();
      } else {
        approverId = String(approverUserId);
      }

      if (!approverId || approverId === 'undefined' || approverId === 'null') {
        logger.warn({ approver, reportId: report._id }, 'Invalid approver userId, skipping');
        continue;
      }

      // Verify approver is from same company as report owner
      if (reportOwner.companyId) {
        const approverUser = await User.findById(approverId).select('companyId').exec();
        if (approverUser?.companyId?.toString() !== reportOwner.companyId.toString()) {
          logger.warn(`Skipping notification to approver ${approverId} - different company`);
          continue;
        }
      }

      try {
        // Create notification record in database (for UI display)
        await NotificationDataService.createNotification({
          userId: approverId,
          companyId: reportOwner.companyId?.toString(),
          type: NotificationType.REPORT_SUBMITTED,
          title: 'New Expense Report Submitted',
          description: `Report "${report.name}" has been submitted by ${reportOwner.name || reportOwner.email || 'an employee'} for your approval`,
          link: `/manager/approvals/${report._id.toString()}`,
          metadata: {
            reportId: report._id.toString(),
            reportName: report.name,
            employeeId: report.userId?.toString(),
            employeeName: reportOwner.name,
            employeeEmail: reportOwner.email,
          },
        });
        logger.info({ approverId, reportId: report._id }, '✅ Notification record created in database');

        // Send email to specific approver
        const approverUser = await User.findById(approverId).select('email').exec();
        if (approverUser?.email) {
          await this.sendEmail({
            to: approverUser.email,
            subject: `New Expense Report: ${report.name}`,
            template: 'report_submitted',
            data: {
              reportName: report.name,
              ownerName: reportOwner.name || reportOwner.email,
              ownerEmail: reportOwner.email,
              reportId: report._id.toString(),
            },
          });
          logger.info({ approverId, email: approverUser.email }, '✅ Email notification sent');
        }
      } catch (error) {
        logger.error({ error, approverId, reportId: report._id }, 'Error creating notification record or sending email');
      }
    }
  }

  static async notifyReportStatusChanged(
    report: any,
    status: ExpenseReportStatus.APPROVED | ExpenseReportStatus.REJECTED
  ): Promise<void> {
    const reportOwner = await User.findById(report.userId).select('name email companyId').exec();

    if (!reportOwner) {
      return;
    }

    const isApproved = status === ExpenseReportStatus.APPROVED;

    // Send push notification
    await this.sendPushToUser(report.userId.toString(), {
      title: isApproved ? 'Report Approved' : 'Report Rejected',
      body: `Your expense report "${report.name}" has been ${status.toLowerCase()}`,
      data: {
        type: isApproved ? 'REPORT_APPROVED' : 'REPORT_REJECTED',
        reportId: report._id.toString(),
        action: isApproved ? 'REPORT_APPROVED' : 'REPORT_REJECTED',
      },
    });

    // Send email
    await this.sendEmail({
      to: reportOwner.email,
      subject: `Expense Report ${isApproved ? 'Approved' : 'Rejected'}: ${report.name}`,
      template: isApproved ? 'report_approved' : 'report_rejected',
      data: {
        reportName: report.name,
        reportId: report._id.toString(),
        totalAmount: report.totalAmount,
        currency: report.currency,
      },
    });
  }

  static async notifyReportChangesRequested(report: any): Promise<void> {
    const reportOwner = await User.findById(report.userId).select('name email companyId').exec();

    if (!reportOwner) {
      return;
    }

    // Send push notification
    await this.sendPushToUser(report.userId.toString(), {
      title: 'Changes Requested',
      body: `Your expense report "${report.name}" requires changes. Please review and resubmit.`,
      data: {
        type: 'REPORT_CHANGES_REQUESTED',
        reportId: report._id.toString(),
        action: 'REPORT_CHANGES_REQUESTED',
      },
    });

    // Send email
    await this.sendEmail({
      to: reportOwner.email,
      subject: `Changes Requested: ${report.name}`,
      template: 'report_changes_requested',
      data: {
        reportName: report.name,
        reportId: report._id.toString(),
      },
    });
  }

  static async notifyNextApprover(report: any, approvers: any[]): Promise<void> {
    if (!approvers || approvers.length === 0) {
      logger.warn({ reportId: report._id }, 'No approvers provided for next approver notification');
      return;
    }

    const reportOwner = await User.findById(report.userId).select('name email companyId').exec();
    if (!reportOwner) {
      logger.warn({ reportId: report._id }, 'Report owner not found, skipping notification');
      return;
    }

    // Determine approver level and role
    const approverLevel = approvers[0]?.level || 2;
    const levelName = approverLevel === 2 ? 'Business Head' : `Level ${approverLevel} Approver`;

    // Level 2 approvers are typically BUSINESS_HEAD role
    const targetRole = approverLevel === 2 ? 'BUSINESS_HEAD' : approvers[0]?.role || 'BUSINESS_HEAD';

    // Send broadcast notification to role-based topic (Firebase FCM)
    try {
      const roleTopic = getRoleTopic(targetRole);
      const messageId = await this.sendBroadcastToTopic(
        {
          title: 'Report Pending Approval',
          body: `Report "${report.name}" is pending your approval (${levelName})`,
          data: {
            type: 'REPORT_PENDING_APPROVAL',
            reportId: report._id.toString(),
            action: 'REPORT_PENDING_APPROVAL',
            level: approverLevel.toString(),
            companyId: reportOwner.companyId?.toString() || '',
          },
        },
        roleTopic
      );
      logger.info({ reportId: report._id, topic: roleTopic, messageId, level: approverLevel }, '✅ Broadcast notification sent to role topic');
    } catch (error: any) {
      logger.error({ error: error.message || error, reportId: report._id, role: targetRole }, '❌ Failed to send broadcast notification to role topic');
      // Continue to create DB records even if FCM fails
    }

    // Create DB notification records and send emails to specific approvers
    const { NotificationDataService } = await import('./notificationData.service');
    const { NotificationType } = await import('../models/Notification');

    for (const approver of approvers) {
      const approverId = approver.userId.toString();

      // Verify approver is from same company as report owner
      if (reportOwner.companyId) {
        const approverUser = await User.findById(approverId).select('companyId').exec();
        if (approverUser?.companyId?.toString() !== reportOwner.companyId.toString()) {
          logger.warn(`Skipping notification to approver ${approverId} - different company`);
          continue;
        }
      }

      try {
        // Create notification record in database (for UI display)
        await NotificationDataService.createNotification({
          userId: approverId,
          companyId: reportOwner.companyId?.toString(),
          type: NotificationType.REPORT_PENDING_APPROVAL,
          title: 'Report Pending Approval',
          description: `Report "${report.name}" is pending your approval (${levelName})`,
          link: `/approvals/${report._id.toString()}`,
          metadata: {
            reportId: report._id.toString(),
            reportName: report.name,
            employeeId: report.userId?.toString(),
            employeeName: reportOwner.name,
            employeeEmail: reportOwner.email,
            level: approverLevel,
          },
        });
        logger.info({ approverId, reportId: report._id }, '✅ Notification record created in database');

        // Send email to specific approver
        const approverUser = await User.findById(approverId).select('email').exec();
        if (approverUser?.email) {
          await this.sendEmail({
            to: approverUser.email,
            subject: `Report Pending Approval: ${report.name}`,
            template: 'report_pending_approval',
            data: {
              reportName: report.name,
              ownerName: reportOwner.name || reportOwner.email,
              ownerEmail: reportOwner.email,
              reportId: report._id.toString(),
              level: approverLevel,
            },
          });
          logger.info({ approverId, email: approverUser.email }, '✅ Email notification sent');
        }
      } catch (error) {
        logger.error({ error, approverId, reportId: report._id }, 'Error creating notification record or sending email');
      }
    }
  }

  static async sendEmail(data: {
    to: string;
    subject: string;
    template: string;
    data: Record<string, any>;
  }): Promise<void> {
    try {
      const fromEmail = getFromEmail();

      // Simple email templates
      let html = '';
      switch (data.template) {
        case 'report_submitted':
          html = `
            <h2>New Expense Report Submitted</h2>
            <p>A new expense report has been submitted for your approval:</p>
            <ul>
              <li><strong>Report:</strong> ${(data as any).reportName}</li>
              <li><strong>Submitted by:</strong> ${(data as any).ownerName} (${(data as any).ownerEmail})</li>
            </ul>
            <p>Please review and approve or reject the report.</p>
          `;
          break;
        case 'report_approved':
          html = `
            <h2>Expense Report Approved</h2>
            <p>Your expense report has been approved:</p>
            <ul>
              <li><strong>Report:</strong> ${(data as any).reportName}</li>
              <li><strong>Total Amount:</strong> ${(data as any).currency} ${(data as any).totalAmount}</li>
            </ul>
            <p>Thank you for submitting your expenses.</p>
          `;
          break;
        case 'report_rejected':
          html = `
            <h2>Expense Report Rejected</h2>
            <p>Your expense report has been rejected:</p>
            <ul>
              <li><strong>Report:</strong> ${(data as any).reportName}</li>
              <li><strong>Total Amount:</strong> ${(data as any).currency} ${(data as any).totalAmount}</li>
            </ul>
            <p>Please review and resubmit if needed.</p>
          `;
          break;
        case 'report_changes_requested':
          html = `
            <h2>Changes Requested</h2>
            <p>Your expense report requires changes:</p>
            <ul>
              <li><strong>Report:</strong> ${(data as any).reportName}</li>
            </ul>
            <p>Please review the comments and resubmit your report.</p>
          `;
          break;
        case 'report_pending_approval':
          html = `
            <h2>Report Pending Approval</h2>
            <p>A new expense report is pending your approval:</p>
            <ul>
              <li><strong>Report:</strong> ${(data as any).reportName}</li>
              <li><strong>Submitted by:</strong> ${(data as any).ownerName} (${(data as any).ownerEmail})</li>
              <li><strong>Approval Level:</strong> ${(data as any).level || 'N/A'}</li>
            </ul>
            <p>Please review and approve or reject the report.</p>
          `;
          break;
        case 'approval_required':
          html = `
            <h2>New Approval Required</h2>
            <p>A new ${(data as any).requestType || 'request'} requires your approval:</p>
            <ul>
              <li><strong>Request:</strong> ${(data as any).requestName}</li>
              <li><strong>Submitted by:</strong> ${(data as any).requesterName}</li>
              <li><strong>Your Role(s):</strong> ${(data as any).roleNames}</li>
              <li><strong>Approval Level:</strong> ${(data as any).level || 'N/A'}</li>
            </ul>
            <p>Please review and approve or reject this request in your Pending Approvals inbox.</p>
          `;
          break;
        case 'request_approved':
          html = `
            <h2>${(data as any).requestType || 'Request'} Approved</h2>
            <p>Your ${(data as any).requestType || 'request'} has been approved:</p>
            <ul>
              <li><strong>Request:</strong> ${(data as any).requestName}</li>
              ${(data as any).comments ? `<li><strong>Comments:</strong> ${(data as any).comments}</li>` : ''}
            </ul>
            <p>Thank you for your submission.</p>
          `;
          break;
        case 'request_rejected':
          html = `
            <h2>${(data as any).requestType || 'Request'} Rejected</h2>
            <p>Your ${(data as any).requestType || 'request'} has been rejected:</p>
            <ul>
              <li><strong>Request:</strong> ${(data as any).requestName}</li>
              ${(data as any).comments ? `<li><strong>Reason:</strong> ${(data as any).comments}</li>` : ''}
            </ul>
            <p>Please review the feedback and resubmit if necessary.</p>
          `;
          break;
        case 'broadcast':
          html = `
            <h2>${(data as any).title || data.subject}</h2>
            <p style="margin: 12px 0; font-size: 14px; line-height: 1.6;">${(data as any).message || ''}</p>
            ${(data as any).type ? `<p style="margin-top: 16px; font-size: 12px; opacity: 0.8;">Type: ${(data as any).type}</p>` : ''}
          `;
          break;
        case 'password_reset':
          const resetLink = (data as any).resetLink || '';
          html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #333; margin-bottom: 20px;">Reset Your Password</h2>
              <p style="color: #666; font-size: 14px; line-height: 1.6; margin-bottom: 20px;">
                You requested to reset your password for your NexPense account. Click the button below to reset your password.
              </p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetLink}" style="display: inline-block; padding: 12px 30px; background-color: #4F46E5; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
                  Reset Password
                </a>
              </div>
              <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 20px;">
                This link will expire in <strong>15 minutes</strong> for security reasons.
              </p>
              <p style="color: #999; font-size: 12px; line-height: 1.6; margin-top: 30px;">
                If you did not request a password reset, please ignore this email. Your password will remain unchanged.
              </p>
              <p style="color: #999; font-size: 12px; line-height: 1.6; margin-top: 10px;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${resetLink}" style="color: #4F46E5; word-break: break-all;">${resetLink}</a>
              </p>
            </div>
          `;
          break;
        default:
          html = `<p>${data.subject}</p>`;
      }

      const client = getResendClient();
      if (!client) {
        logger.warn({ 
          to: data.to, 
          subject: data.subject,
          apiKeyConfigured: !!config.resend.apiKey,
          fromEmail: fromEmail 
        }, 'Resend not configured - email not sent');
        return;
      }

      logger.info({ 
        to: data.to, 
        from: fromEmail,
        subject: data.subject 
      }, 'Attempting to send email via Resend');

      const result = await client.emails.send({
        from: fromEmail,
        to: data.to,
        subject: data.subject,
        html,
      });

      logger.info({ 
        to: data.to, 
        subject: data.subject,
        result: result.data || result.error 
      }, 'Email send result from Resend');
    } catch (error: any) {
      logger.error({ 
        error: error.message || error,
        errorDetails: error,
        to: data.to,
        subject: data.subject,
        stack: error.stack 
      }, 'Error sending email via Resend');
      // Don't throw - emails are non-critical
    }
  }
}


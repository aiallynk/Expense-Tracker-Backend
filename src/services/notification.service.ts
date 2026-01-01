import mongoose from 'mongoose';
import { getMessaging } from '../config/firebase';
import { getResendClient, getFromEmail } from '../config/resend';
import { NotificationToken } from '../models/NotificationToken';
import { User } from '../models/User';
// import { ExpenseReport } from '../models/ExpenseReport'; // Unused
import { NotificationPlatform , ExpenseReportStatus } from '../utils/enums';
import { getAllUsersTopic, getCompanyTopic } from '../utils/topicUtils';

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
        { token: token }
      ]
    });

    // Create or update user's token
    await NotificationToken.findOneAndUpdate(
      { userId, platform },
      {
        userId,
        token: token,
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
   */
  static async subscribeTokenToTopics(userId: string, token: string): Promise<void> {
    const messaging = getMessaging();
    if (!messaging) {
      logger.debug('Firebase not configured - skipping topic subscription');
      return;
    }

    try {
      // Get user to check companyId
      const user = await User.findById(userId).select('companyId').exec();
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

      // Subscribe to all topics
      for (const topic of topics) {
        try {
          await messaging.subscribeToTopic([token], topic);
          logger.debug(`Subscribed token to topic: ${topic} for user ${userId}`);
        } catch (error: any) {
          // Log but continue with other topics
          logger.warn({ error: error.message || error, topic, userId }, `Failed to subscribe to topic ${topic}`);
        }
      }

      logger.info(`Topic subscription completed for user ${userId}, subscribed to ${topics.length} topic(s)`);
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
      const message = {
        topic,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: dataPayload,
      };

      const messageId = await messaging.send(message);
      logger.info(`Broadcast notification sent to topic "${topic}", messageId: ${messageId}`);
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

      const message = {
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: dataPayload,
        tokens: fcmTokens,
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
    // Notify Level 1 approvers (managers) from the approver chain
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

    // Get Level 1 approvers (managers)
    const level1Approvers = report.approvers.filter(
      (approver: any) => approver.level === 1 && !approver.decidedAt
    );

    if (level1Approvers.length === 0) {
      logger.warn({ reportId: report._id }, 'No Level 1 approvers found for report (or all have decided)');
      return;
    }

    logger.info({ 
      reportId: report._id, 
      level1ApproversCount: level1Approvers.length,
      level1ApproverIds: level1Approvers.map((a: any) => {
        // Handle both ObjectId and string formats
        const userId = a.userId;
        if (typeof userId === 'string') return userId;
        if (userId && typeof userId.toString === 'function') return userId.toString();
        return String(userId);
      })
    }, 'Found Level 1 approvers to notify');

    // Get report owner for email context
    const reportOwner = await User.findById(report.userId).select('name email companyId').exec();

    // Notify each Level 1 approver
    for (const approver of level1Approvers) {
      // Handle both ObjectId and string formats
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
      if (reportOwner?.companyId) {
        const approverUser = await User.findById(approverId).select('companyId').exec();
        if (approverUser?.companyId?.toString() !== reportOwner.companyId.toString()) {
          logger.warn(`Skipping notification to approver ${approverId} - different company`);
          continue;
        }
      }

      try {
        // Create notification record in database first (so it appears in UI even if push fails)
        const { NotificationDataService } = await import('./notificationData.service');
        const { NotificationType } = await import('../models/Notification');
        
        await NotificationDataService.createNotification({
          userId: approverId,
          companyId: reportOwner?.companyId?.toString(),
          type: NotificationType.REPORT_SUBMITTED,
          title: 'New Expense Report Submitted',
          description: `Report "${report.name}" has been submitted by ${reportOwner?.name || reportOwner?.email || 'an employee'} for your approval`,
          link: `/manager/approvals/${report._id.toString()}`,
          metadata: {
            reportId: report._id.toString(),
            reportName: report.name,
            employeeId: report.userId?.toString(),
            employeeName: reportOwner?.name,
            employeeEmail: reportOwner?.email,
          },
        });
        logger.info({ approverId, reportId: report._id }, 'Notification record created in database');

        // Send push notification
        logger.info({ approverId, reportId: report._id }, 'Sending push notification to approver');
        await this.sendPushToUser(approverId, {
          title: 'New Expense Report Submitted',
          body: `Report "${report.name}" has been submitted for your approval`,
          data: {
            type: 'REPORT_SUBMITTED',
            reportId: report._id.toString(),
            action: 'REPORT_SUBMITTED',
          },
        });
        logger.info({ approverId, reportId: report._id }, 'Push notification sent successfully');
      } catch (error) {
        logger.error({ error, approverId, reportId: report._id }, 'Error sending notification to approver');
      }

      // Send email to approver
      try {
        const approverUser = await User.findById(approverId).select('email').exec();
        if (approverUser?.email && reportOwner) {
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
          logger.info({ approverId, email: approverUser.email }, 'Email notification sent');
        }
      } catch (error) {
        logger.error({ error, approverId }, 'Error sending email notification');
        // Don't fail if email fails
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
    const reportOwner = await User.findById(report.userId).select('name email companyId').exec();

    for (const approver of approvers) {
      const approverId = approver.userId.toString();
      
      // Verify approver is from same company as report owner
      if (reportOwner?.companyId) {
        const approverUser = await User.findById(approverId).select('companyId').exec();
        if (approverUser?.companyId?.toString() !== reportOwner.companyId.toString()) {
          logger.warn(`Skipping notification to approver ${approverId} - different company`);
          continue;
        }
      }

      const approverLevel = approver.level;
      const levelName = approverLevel === 2 ? 'Business Head' : `Level ${approverLevel} Approver`;

      await this.sendPushToUser(approverId, {
        title: 'Report Pending Approval',
        body: `Report "${report.name}" is pending your approval (${levelName})`,
        data: {
          type: 'REPORT_PENDING_APPROVAL',
          reportId: report._id.toString(),
          action: 'REPORT_PENDING_APPROVAL',
          level: approverLevel.toString(),
        },
      });

      // Send email
      const approverUser = await User.findById(approverId).select('email').exec();
      if (approverUser?.email && reportOwner) {
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
        default:
          html = `<p>${data.subject}</p>`;
      }

      const client = getResendClient();
      if (!client) {
        logger.warn('Resend not configured - email not sent');
        return;
      }

      await client.emails.send({
        from: fromEmail,
        to: data.to,
        subject: data.subject,
        html,
      });
    } catch (error) {
      logger.error({ error }, 'Error sending email');
      // Don't throw - emails are non-critical
    }
  }
}


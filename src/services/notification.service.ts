import { getMessaging } from '../config/firebase';
import { getResendClient, getFromEmail } from '../config/resend';
import { NotificationToken } from '../models/NotificationToken';
import { User } from '../models/User';
// import { ExpenseReport } from '../models/ExpenseReport'; // Unused
import { NotificationPlatform , ExpenseReportStatus } from '../utils/enums';

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

      // Find tokens for this user
      const tokens = await NotificationToken.find({ userId }).select('fcmToken platform');

      if (tokens.length === 0) {
        logger.debug(`No FCM tokens found for user ${userId}`);
        return;
      }

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
      logger.debug('No approvers found for report, skipping notification');
      return;
    }

    // Get Level 1 approvers (managers)
    const level1Approvers = report.approvers.filter(
      (approver: any) => approver.level === 1 && !approver.decidedAt
    );

    if (level1Approvers.length === 0) {
      logger.debug('No Level 1 approvers found for report');
      return;
    }

    // Get report owner for email context
    const reportOwner = await User.findById(report.userId).select('name email companyId').exec();

    // Notify each Level 1 approver
    for (const approver of level1Approvers) {
      const approverId = approver.userId.toString();
      
      // Verify approver is from same company as report owner
      if (reportOwner?.companyId) {
        const approverUser = await User.findById(approverId).select('companyId').exec();
        if (approverUser?.companyId?.toString() !== reportOwner.companyId.toString()) {
          logger.warn(`Skipping notification to approver ${approverId} - different company`);
          continue;
        }
      }

      await this.sendPushToUser(approverId, {
        title: 'New Expense Report Submitted',
        body: `Report "${report.name}" has been submitted for your approval`,
        data: {
          type: 'REPORT_SUBMITTED',
          reportId: report._id.toString(),
          action: 'REPORT_SUBMITTED',
        },
      });

      // Send email to approver
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


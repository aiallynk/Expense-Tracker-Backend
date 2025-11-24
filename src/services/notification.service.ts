import mongoose from 'mongoose';

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
    // Remove existing token if exists
    await NotificationToken.findOneAndDelete({ fcmToken: token });

    // Create or update user's token
    await NotificationToken.findOneAndUpdate(
      { userId, platform },
      {
        userId,
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
      const tokens = await NotificationToken.find({ userId }).select('fcmToken');

      if (tokens.length === 0) {
        logger.debug(`No FCM tokens found for user ${userId}`);
        return;
      }

      const fcmTokens = tokens.map((t) => t.fcmToken);
      const messaging = getMessaging();

      if (!messaging) {
        logger.debug('Firebase not configured - push notification skipped');
        return;
      }

      const message = {
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data || {},
        tokens: fcmTokens.filter((t): t is string => t !== undefined),
      };

      await messaging.sendEachForMulticast(message);
    } catch (error) {
      logger.error({ error }, 'Error sending push notification');
      // Don't throw - notifications are non-critical
    }
  }

  static async notifyReportSubmitted(report: any): Promise<void> {
    // Notify admins via push
    const admins = await User.find({
      role: { $in: ['ADMIN', 'BUSINESS_HEAD'] },
      status: 'ACTIVE',
    }).select('_id');

    for (const admin of admins) {
      await this.sendPushToUser((admin._id as mongoose.Types.ObjectId).toString(), {
        title: 'New Expense Report Submitted',
        body: `Report "${report.name}" has been submitted for approval`,
        data: {
          type: 'REPORT_SUBMITTED',
          reportId: report._id.toString(),
        },
      });
    }

    // Send email to admins
    const reportOwner = await User.findById(report.userId).select('name email');
    if (reportOwner) {
      for (const admin of admins) {
        const adminUser = await User.findById(admin._id).select('email');
        if (adminUser?.email) {
          await this.sendEmail({
            to: adminUser.email,
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
  }

  static async notifyReportStatusChanged(
    report: any,
    status: ExpenseReportStatus.APPROVED | ExpenseReportStatus.REJECTED
  ): Promise<void> {
    const reportOwner = await User.findById(report.userId).select('name email');

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


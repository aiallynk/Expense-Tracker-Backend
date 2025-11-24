import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { ExpenseReport, IExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { ExpenseReportStatus, UserRole } from '../utils/enums';


import { currencyService } from './currency.service';

import { logger } from '@/config/logger';

export class BusinessHeadService {
  /**
   * Get business head dashboard statistics
   */
  static async getDashboardStats(businessHeadId: string): Promise<any> {
    try {
      // Get business head user to find company
      const businessHead = await User.findById(businessHeadId)
        .select('companyId')
        .exec();

      if (!businessHead || !businessHead.companyId) {
        return {
          totalCompanySpend: 0,
          reportsApprovedByManagers: 0,
          pendingBHApproval: 0,
          highValueReports: 0,
          companyExpenses: [],
          monthlyTrends: [],
          pendingReportsByDepartment: [],
        };
      }

      const companyId = businessHead.companyId;

      // Get all users in the company
      const companyUsers = await User.find({
        companyId,
        status: 'ACTIVE',
      }).select('_id').exec();

      const userIds = companyUsers.map(u => u._id);

      // Get all approved reports (manager approved and fully approved)
      const approvedReports = await ExpenseReport.find({
        userId: { $in: userIds },
        status: { $in: [ExpenseReportStatus.MANAGER_APPROVED, ExpenseReportStatus.APPROVED] },
      })
        .select('totalAmount currency')
        .exec();

      // Get pending reports (manager approved, waiting for BH approval)
      const pendingReports = await ExpenseReport.find({
        userId: { $in: userIds },
        status: ExpenseReportStatus.MANAGER_APPROVED,
      })
        .populate('userId', 'name email departmentId')
        .exec();

      // Calculate total company spend with currency conversion
      const convertedAmounts = await Promise.all(
        approvedReports.map(async (report) => {
          const amount = report.totalAmount || 0;
          const currency = report.currency || 'INR';
          return await currencyService.convertToINR(amount, currency);
        })
      );

      const totalCompanySpend = convertedAmounts.reduce((sum, amount) => sum + amount, 0);

      // Get reports approved by managers this month
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const reportsApprovedByManagers = await ExpenseReport.countDocuments({
        userId: { $in: userIds },
        status: ExpenseReportStatus.MANAGER_APPROVED,
        approvedAt: { $gte: startOfMonth },
      });

      // High-value reports (>5000 INR equivalent)
      const highValueThreshold = 5000;
      const highValueReportsPromises = approvedReports.map(async (report) => {
        const amount = report.totalAmount || 0;
        const currency = report.currency || 'INR';
        const converted = await currencyService.convertToINR(amount, currency);
        return converted >= highValueThreshold;
      });
      const highValueReportsResults = await Promise.all(highValueReportsPromises);
      const highValueReports = highValueReportsResults.filter(Boolean).length;

      // Category breakdown
      const reportIds = approvedReports.map(r => r._id);
      const expenses = await Expense.find({
        reportId: { $in: reportIds },
      })
        .populate('categoryId', 'name')
        .select('amount currency categoryId')
        .exec();

      const categoryMap = new Map<string, number>();
      for (const exp of expenses) {
        const categoryName = (exp.categoryId as any)?.name || 'Uncategorized';
          const convertedAmount = await currencyService.convertToINR(
            exp.amount || 0,
            exp.currency || 'USD'
          );
        categoryMap.set(
          categoryName,
          (categoryMap.get(categoryName) || 0) + convertedAmount
        );
      }

      const companyExpenses = Array.from(categoryMap.entries()).map(([name, value]) => ({
        name,
        value: Math.round(value * 100) / 100,
      }));

      // Monthly trends (last 6 months)
      const monthlyTrends = [];
      for (let i = 5; i >= 0; i--) {
        const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const count = await ExpenseReport.countDocuments({
          userId: { $in: userIds },
          status: ExpenseReportStatus.MANAGER_APPROVED,
          approvedAt: { $gte: monthStart, $lte: monthEnd },
        });
        monthlyTrends.push({
          name: monthStart.toLocaleDateString('en-US', { month: 'short' }),
          value: count,
        });
      }

      // Pending reports by department
      const departmentMap = new Map<string, number>();
      for (const report of pendingReports) {
        const user = report.userId as any;
        const departmentName = user?.departmentId?.name || 'Unassigned';
        departmentMap.set(
          departmentName,
          (departmentMap.get(departmentName) || 0) + 1
        );
      }

      const pendingReportsByDepartment = Array.from(departmentMap.entries()).map(([name, value]) => ({
        name,
        value,
      }));

      return {
        totalCompanySpend: Math.round(totalCompanySpend * 100) / 100,
        reportsApprovedByManagers,
        pendingBHApproval: pendingReports.length,
        highValueReports,
        companyExpenses,
        monthlyTrends,
        pendingReportsByDepartment,
      };
    } catch (error: any) {
      logger.error({ error: error }, 'Error getting business head dashboard stats:');
      throw error;
    }
  }

  /**
   * Get all managers in the company
   */
  static async getManagers(businessHeadId: string): Promise<any[]> {
    try {
      const businessHead = await User.findById(businessHeadId)
        .select('companyId')
        .exec();

      if (!businessHead || !businessHead.companyId) {
        return [];
      }

      const managers = await User.find({
        companyId: businessHead.companyId,
        role: UserRole.MANAGER,
        status: 'ACTIVE',
      })
        .select('name email phone departmentId')
        .populate('departmentId', 'name')
        .exec();

      // Get statistics for each manager
      const managersWithStats = await Promise.all(
        managers.map(async (manager) => {
          // Get team size (direct reports)
          const teamSize = await User.countDocuments({
            managerId: manager._id,
            status: 'ACTIVE',
          });

          // Get team member IDs
          const teamMembers = await User.find({ managerId: manager._id }).select('_id').exec();
          const teamUserIds = teamMembers.map(u => u._id);

          // Get reports approved by manager
          const reportsApprovedByManager = await ExpenseReport.countDocuments({
            userId: { $in: teamUserIds },
            status: ExpenseReportStatus.MANAGER_APPROVED,
          });

          // Get pending BH approval
          const pendingBHApproval = await ExpenseReport.countDocuments({
            userId: { $in: teamUserIds },
            status: ExpenseReportStatus.MANAGER_APPROVED,
          });

          // Get BH approved reports
          const bhApprovedReports = await ExpenseReport.countDocuments({
            userId: { $in: teamUserIds },
            status: ExpenseReportStatus.APPROVED,
            approvers: {
              $elemMatch: {
                userId: new mongoose.Types.ObjectId(businessHeadId),
                level: 2,
              },
            },
          });

          // Get BH rejected reports
          const bhRejectedReports = await ExpenseReport.countDocuments({
            userId: { $in: teamUserIds },
            status: ExpenseReportStatus.REJECTED,
            approvers: {
              $elemMatch: {
                userId: new mongoose.Types.ObjectId(businessHeadId),
                level: 2,
                action: 'reject',
              },
            },
          });

          // Monthly reports approved (last 6 months)
          const monthlyReportsApproved = [];
          const now = new Date();
          for (let i = 5; i >= 0; i--) {
            const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
            const count = await ExpenseReport.countDocuments({
              userId: { $in: teamUserIds },
              status: ExpenseReportStatus.MANAGER_APPROVED,
              approvedAt: { $gte: monthStart, $lte: monthEnd },
            });
            monthlyReportsApproved.push({
              month: monthStart.toLocaleDateString('en-US', { month: 'short' }),
              count,
            });
          }

          // Category breakdown
          const teamReports = await ExpenseReport.find({
            userId: { $in: teamUserIds },
            status: ExpenseReportStatus.MANAGER_APPROVED,
          }).select('_id').exec();
          const teamReportIds = teamReports.map(r => r._id);

          const teamExpenses = await Expense.find({
            reportId: { $in: teamReportIds },
          })
            .populate('categoryId', 'name')
            .select('categoryId')
            .exec();

          const categoryMap = new Map<string, number>();
          teamExpenses.forEach((exp) => {
            const categoryName = (exp.categoryId as any)?.name || 'Uncategorized';
            categoryMap.set(
              categoryName,
              (categoryMap.get(categoryName) || 0) + 1
            );
          });

          const reportCategoryBreakdown = Array.from(categoryMap.entries()).map(([name, count]) => ({
            name,
            count,
          }));

          return {
            id: (manager._id as any).toString(),
            name: manager.name,
            email: manager.email,
            phone: manager.phone,
            employeeId: (manager._id as any).toString().slice(-6).toUpperCase(),
            department: (manager.departmentId as any)?.name || 'Unassigned',
            teamSize,
            reportsApprovedByManager,
            pendingBHApproval,
            bhApprovedReports,
            bhRejectedReports,
            monthlyReportsApproved,
            reportCategoryBreakdown,
          };
        })
      );

      return managersWithStats;
    } catch (error: any) {
      logger.error({ error: error }, 'Error getting managers:');
      throw error;
    }
  }

  /**
   * Get all company reports
   */
  static async getCompanyReports(
    businessHeadId: string,
    filters: {
      status?: string;
      department?: string;
      search?: string;
      page?: number;
      pageSize?: number;
      dateFrom?: string;
      dateTo?: string;
    }
  ): Promise<{ reports: any[]; total: number }> {
    try {
      const businessHead = await User.findById(businessHeadId)
        .select('companyId')
        .exec();

      if (!businessHead || !businessHead.companyId) {
        return { reports: [], total: 0 };
      }

      const companyUsers = await User.find({
        companyId: businessHead.companyId,
        status: 'ACTIVE',
      }).select('_id').exec();

      const userIds = companyUsers.map(u => u._id);

      const query: any = {
        userId: { $in: userIds },
      };

      if (filters.status && filters.status !== 'all') {
        query.status = filters.status.toUpperCase();
      }

      if (filters.search) {
        query.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { notes: { $regex: filters.search, $options: 'i' } },
        ];
      }

      if (filters.dateFrom || filters.dateTo) {
        query.submittedAt = {};
        if (filters.dateFrom) {
          query.submittedAt.$gte = new Date(filters.dateFrom);
        }
        if (filters.dateTo) {
          query.submittedAt.$lte = new Date(filters.dateTo);
        }
      }

      const page = filters.page || 1;
      const pageSize = filters.pageSize || 20;
      const skip = (page - 1) * pageSize;

      const [reports, total] = await Promise.all([
        ExpenseReport.find(query)
          .populate('userId', 'name email')
          .populate('projectId', 'name code')
          .sort({ submittedAt: -1 })
          .skip(skip)
          .limit(pageSize)
          .exec(),
        ExpenseReport.countDocuments(query).exec(),
      ]);

      // Get manager info for each report
      const reportsWithManager = await Promise.all(
        reports.map(async (report) => {
          const user = report.userId as any;
          const employee = await User.findById(user._id || user)
            .select('managerId')
            .populate('managerId', 'name email')
            .exec();

          const manager = employee?.managerId as any;

          // Convert amount to INR
          const convertedAmount = await currencyService.convertToINR(
            report.totalAmount || 0,
            report.currency || 'USD'
          );

          // Get expense count
          const expenseCount = await Expense.countDocuments({
            reportId: report._id,
          });

          // Get category
          const firstExpense = await Expense.findOne({ reportId: report._id })
            .populate('categoryId', 'name')
            .exec();
          const category = (firstExpense?.categoryId as any)?.name || 'Other';

          return {
            id: (report._id as any).toString(),
            reportName: report.name,
            employeeName: user?.name || 'Unknown',
            employeeEmail: user?.email || '',
            managerName: manager?.name || 'Unassigned',
            department: (user?.departmentId as any)?.name || 'Unassigned',
            status: report.status.toLowerCase(),
            amount: Math.round(convertedAmount * 100) / 100,
            originalAmount: report.totalAmount,
            originalCurrency: report.currency,
            submittedDate: report.submittedAt?.toISOString().split('T')[0] || '',
            approvedDate: report.approvedAt?.toISOString().split('T')[0] || null,
            expenseCount,
            category,
          };
        })
      );

      return {
        reports: reportsWithManager,
        total,
      };
    } catch (error: any) {
      logger.error({ error: error }, 'Error getting company reports:');
      throw error;
    }
  }

  /**
   * Get pending reports (manager approved, waiting for BH approval)
   */
  static async getPendingReports(businessHeadId: string): Promise<any[]> {
    try {
      const businessHead = await User.findById(businessHeadId)
        .select('companyId')
        .exec();

      if (!businessHead || !businessHead.companyId) {
        return [];
      }

      const companyUsers = await User.find({
        companyId: businessHead.companyId,
        status: 'ACTIVE',
      }).select('_id').exec();

      const userIds = companyUsers.map(u => u._id);

      const reports = await ExpenseReport.find({
        userId: { $in: userIds },
        status: ExpenseReportStatus.MANAGER_APPROVED,
      })
        .populate('userId', 'name email departmentId')
        .populate('projectId', 'name')
        .sort({ submittedAt: -1 })
        .exec();

      const pendingReportsWithDetails = await Promise.all(
        reports.map(async (report) => {
          const user = report.userId as any;
          const employee = await User.findById(user._id || user)
            .select('managerId')
            .populate('managerId', 'name email')
            .exec();

          const manager = employee?.managerId as any;

          // Get expenses for category breakdown
          const expenses = await Expense.find({
            reportId: report._id,
          })
            .populate('categoryId', 'name')
            .select('amount currency categoryId')
            .exec();

          const categoryMap = new Map<string, number>();
          for (const exp of expenses) {
            const categoryName = (exp.categoryId as any)?.name || 'Uncategorized';
          const convertedAmount = await currencyService.convertToINR(
            exp.amount || 0,
            exp.currency || 'USD'
          );
            categoryMap.set(
              categoryName,
              (categoryMap.get(categoryName) || 0) + convertedAmount
            );
          }

          const categoryBreakdown = Array.from(categoryMap.entries()).map(([category, amount]) => ({
            category,
            amount: Math.round(amount * 100) / 100,
          }));

          // Convert total amount to INR
          const convertedAmount = await currencyService.convertToINR(
            report.totalAmount || 0,
            report.currency || 'USD'
          );

          // Determine priority (high if >5000 INR, medium if >2000, low otherwise)
          let priority = 'low';
          if (convertedAmount >= 5000) {
            priority = 'high';
          } else if (convertedAmount >= 2000) {
            priority = 'medium';
          }

          return {
            id: (report._id as any).toString(),
            reportName: report.name,
            managerName: manager?.name || 'Unassigned',
            managerEmail: manager?.email || '',
            department: (user?.departmentId as any)?.name || 'Unassigned',
            employeeName: user?.name || 'Unknown',
            employeeEmail: user?.email || '',
            dateRange: `${report.fromDate?.toISOString().split('T')[0]} to ${report.toDate?.toISOString().split('T')[0]}`,
            submittedDate: report.submittedAt?.toISOString().split('T')[0] || '',
            managerApprovedDate: report.approvedAt?.toISOString().split('T')[0] || '',
            totalAmount: Math.round(convertedAmount * 100) / 100,
            originalAmount: report.totalAmount,
            originalCurrency: report.currency,
            expenseCount: expenses.length,
            categoryBreakdown,
            priority,
            status: 'pending',
          };
        })
      );

      return pendingReportsWithDetails;
    } catch (error: any) {
      logger.error({ error: error }, 'Error getting pending reports:');
      throw error;
    }
  }

  /**
   * Business head approves a report
   */
  static async approveReport(
    reportId: string,
    businessHeadId: string,
    comment?: string
  ): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email managerId')
      .exec();

    if (!report) {
      const error: any = new Error('Report not found');
      error.statusCode = 404;
      error.code = 'REPORT_NOT_FOUND';
      throw error;
    }

    // Verify report is in MANAGER_APPROVED status
    if (report.status !== ExpenseReportStatus.MANAGER_APPROVED) {
      const error: any = new Error(`Cannot approve report with status: ${report.status}`);
      error.statusCode = 400;
      error.code = 'INVALID_STATUS';
      throw error;
    }

    // Update approvers array
    const approverIndex = report.approvers.findIndex(
      (a: any) => a.userId.toString() === businessHeadId && a.level === 2
    );

    const approverData = {
      level: 2,
      userId: new mongoose.Types.ObjectId(businessHeadId),
      role: 'BUSINESS_HEAD',
      decidedAt: new Date(),
      action: 'approve',
      comment: comment || undefined,
    };

    if (approverIndex >= 0) {
      report.approvers[approverIndex] = approverData;
    } else {
      report.approvers.push(approverData);
    }

    // Update report status to APPROVED
    report.status = ExpenseReportStatus.APPROVED;
    report.approvedAt = new Date();
    report.updatedBy = new mongoose.Types.ObjectId(businessHeadId);

    await report.save();

    // Send notification
    try {
      const { NotificationDataService } = await import('./notificationData.service');
      const { NotificationType } = await import('../models/Notification');
      const reportUser = report.userId as any;
      await NotificationDataService.createNotification({
        userId: reportUser._id?.toString() || reportUser.toString(),
        type: NotificationType.REPORT_APPROVED,
        title: 'Report Approved',
        description: `Your report "${report.name}" has been approved by the business head.`,
        link: `/reports/${reportId}`,
        companyId: reportUser.companyId?.toString()
      });
    } catch (error) {
      logger.error({ error: error }, 'Error sending notification:');
    }

    return report;
  }

  /**
   * Business head rejects a report
   */
  static async rejectReport(
    reportId: string,
    businessHeadId: string,
    comment?: string
  ): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email managerId')
      .exec();

    if (!report) {
      const error: any = new Error('Report not found');
      error.statusCode = 404;
      error.code = 'REPORT_NOT_FOUND';
      throw error;
    }

    // Verify report is in MANAGER_APPROVED status
    if (report.status !== ExpenseReportStatus.MANAGER_APPROVED) {
      const error: any = new Error(`Cannot reject report with status: ${report.status}`);
      error.statusCode = 400;
      error.code = 'INVALID_STATUS';
      throw error;
    }

    // Update approvers array
    const approverIndex = report.approvers.findIndex(
      (a: any) => a.userId.toString() === businessHeadId && a.level === 2
    );

    const approverData = {
      level: 2,
      userId: new mongoose.Types.ObjectId(businessHeadId),
      role: 'BUSINESS_HEAD',
      decidedAt: new Date(),
      action: 'reject',
      comment: comment || undefined,
    };

    if (approverIndex >= 0) {
      report.approvers[approverIndex] = approverData;
    } else {
      report.approvers.push(approverData);
    }

    // Update report status to REJECTED
    report.status = ExpenseReportStatus.REJECTED;
    report.rejectedAt = new Date();
    report.updatedBy = new mongoose.Types.ObjectId(businessHeadId);

    await report.save();

    // Send notification
    try {
      const { NotificationDataService } = await import('./notificationData.service');
      const { NotificationType } = await import('../models/Notification');
      const reportUser = report.userId as any;
      await NotificationDataService.createNotification({
        userId: reportUser._id?.toString() || reportUser.toString(),
        type: NotificationType.REPORT_REJECTED,
        title: 'Report Rejected',
        description: `Your report "${report.name}" has been rejected by the business head.${comment ? ` Reason: ${comment}` : ''}`,
        link: `/reports/${reportId}`,
        companyId: reportUser.companyId?.toString()
      });
    } catch (error) {
      logger.error({ error: error }, 'Error sending notification:');
    }

    return report;
  }
}


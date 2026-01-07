import mongoose from 'mongoose';

import { CompanyAdmin } from '../models/CompanyAdmin';
import { User } from '../models/User';
import { emitCompanyAdminDashboardUpdate } from '../socket/realtimeEvents';
import { ExpenseReportStatus } from '../utils/enums';

import { logger } from '@/config/logger';


export class CompanyAdminDashboardService {
  /**
   * Collect and emit dashboard stats for all companies
   */
  static async collectAndEmitDashboardStats(): Promise<void> {
    try {
      // Get all company admins with their company IDs
      const companyAdmins = await CompanyAdmin.find({})
        .select('companyId')
        .populate('companyId', '_id')
        .exec();

      // Process each company
      for (const admin of companyAdmins) {
        if (!admin.companyId) continue;

        const companyId = (admin.companyId as any)._id?.toString() || admin.companyId.toString();

        try {
          const stats = await this.getDashboardStatsForCompany(companyId);
          emitCompanyAdminDashboardUpdate(companyId, stats);
        } catch (error) {
          logger.error({ error, companyId }, 'Error collecting dashboard stats for company');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error in collectAndEmitDashboardStats');
    }
  }

  /**
   * Get dashboard stats for a specific company
   */
  static async getDashboardStatsForCompany(companyId: string): Promise<any> {
    const { ExpenseReport } = await import('../models/ExpenseReport');
    const { Expense: ExpenseModel } = await import('../models/Expense');

    // Get all user IDs in this company
    const companyUsers = await User.find({ companyId: new mongoose.Types.ObjectId(companyId) })
      .select('_id role')
      .exec();
    const userIds = companyUsers.map(u => u._id);

    if (userIds.length === 0) {
      return {
        totalUsers: 0,
        employees: 0,
        managers: 0,
        businessHeads: 0,
        totalReports: 0,
        pendingApprovals: 0,
        totalSpendThisMonth: 0,
        userTrend: 0,
        reportsTrend: 0,
        spendTrend: 0,
      };
    }

    // Calculate date range for this month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    // Build queries
    const reportQuery = { userId: { $in: userIds } };

    const approvedReportStatuses = [
      ExpenseReportStatus.MANAGER_APPROVED,
      ExpenseReportStatus.BH_APPROVED,
      ExpenseReportStatus.APPROVED,
      ExpenseReportStatus.PENDING_APPROVAL_L1,
      ExpenseReportStatus.PENDING_APPROVAL_L2,
      ExpenseReportStatus.PENDING_APPROVAL_L3,
      ExpenseReportStatus.PENDING_APPROVAL_L4,
      ExpenseReportStatus.PENDING_APPROVAL_L5,
    ];

    const approvedReports = await ExpenseReport.find({
      ...reportQuery,
      status: { $in: approvedReportStatuses },
    })
      .select('_id')
      .exec();

    const approvedReportIds = approvedReports.map((r) => r._id);

    const baseApprovedExpenseQuery: any = {
      userId: { $in: userIds },
    };

    if (approvedReportIds.length > 0) {
      baseApprovedExpenseQuery.reportId = { $in: approvedReportIds };
    } else {
      // No approved reports → no approved spend
      return {
        totalUsers: await User.countDocuments({ companyId: new mongoose.Types.ObjectId(companyId) }),
        employees: companyUsers.filter(u => u.role === 'EMPLOYEE').length,
        managers: companyUsers.filter(u => u.role === 'MANAGER').length,
        businessHeads: companyUsers.filter(u => u.role === 'BUSINESS_HEAD').length,
        totalReports: await ExpenseReport.countDocuments(reportQuery),
        pendingApprovals: await ExpenseReport.countDocuments({
          ...reportQuery,
          status: {
            $in: [
              ExpenseReportStatus.SUBMITTED,
              ExpenseReportStatus.PENDING_APPROVAL_L1,
              ExpenseReportStatus.PENDING_APPROVAL_L2,
              ExpenseReportStatus.PENDING_APPROVAL_L3,
              ExpenseReportStatus.PENDING_APPROVAL_L4,
              ExpenseReportStatus.PENDING_APPROVAL_L5
            ]
          }
        }),
        totalSpendThisMonth: 0,
        userTrend: 0,
        reportsTrend: 0,
        spendTrend: 0,
      };
    }

    const monthExpenseQuery = {
      ...baseApprovedExpenseQuery,
      expenseDate: {
        $gte: startOfMonth,
        $lte: endOfMonth,
      },
    };

    // Calculate last month for trends
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const lastMonthExpenseQuery = {
      ...baseApprovedExpenseQuery,
      expenseDate: {
        $gte: lastMonthStart,
        $lte: lastMonthEnd,
      },
    };

    const [
      totalReports,
      pendingReports,
      totalAmountThisMonth,
      totalAmountLastMonth,
      totalUsers,
    ] = await Promise.all([
      ExpenseReport.countDocuments(reportQuery),
      ExpenseReport.countDocuments({
        ...reportQuery,
        status: {
          $in: [
            ExpenseReportStatus.SUBMITTED,
            ExpenseReportStatus.PENDING_APPROVAL_L1,
            ExpenseReportStatus.PENDING_APPROVAL_L2,
            ExpenseReportStatus.PENDING_APPROVAL_L3,
            ExpenseReportStatus.PENDING_APPROVAL_L4,
            ExpenseReportStatus.PENDING_APPROVAL_L5
          ]
        }
      }),
      ExpenseModel.aggregate([
        { $match: monthExpenseQuery },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      ExpenseModel.aggregate([
        { $match: lastMonthExpenseQuery },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.countDocuments({ companyId: new mongoose.Types.ObjectId(companyId) }),
    ]);

    // Calculate user breakdown
    const employees = companyUsers.filter(u => u.role === 'EMPLOYEE').length;
    const managers = companyUsers.filter(u => u.role === 'MANAGER').length;
    const businessHeads = companyUsers.filter(u => u.role === 'BUSINESS_HEAD').length;

    // Calculate trends (simplified - compare with previous period)
    const spendThisMonth = totalAmountThisMonth[0]?.total || 0;
    const spendLastMonth = totalAmountLastMonth[0]?.total || 0;
    const spendTrend = spendLastMonth > 0
      ? ((spendThisMonth - spendLastMonth) / spendLastMonth) * 100
      : 0;

    return {
      totalUsers,
      employees,
      managers,
      businessHeads,
      totalReports,
      pendingApprovals: pendingReports,
      totalSpendThisMonth: spendThisMonth,
      userTrend: 0, // Can be calculated if needed
      reportsTrend: 0, // Can be calculated if needed
      spendTrend,
    };
  }
}


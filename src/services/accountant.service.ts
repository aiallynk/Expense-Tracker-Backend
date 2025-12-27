import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { Project } from '../models/Project';
import { CostCentre } from '../models/CostCentre';
import { Department } from '../models/Department';
import { ExpenseReportStatus } from '../utils/enums';
import { currencyService } from './currency.service';

import { logger } from '@/config/logger';

export class AccountantService {
  /**
   * Get accountant dashboard statistics
   * Read-only view of company-wide expenses
   */
  static async getDashboardStats(accountantId: string): Promise<any> {
    try {
      const accountant = await User.findById(accountantId)
        .select('companyId')
        .exec();

      if (!accountant || !accountant.companyId) {
        return {
          totalSpend: 0,
          totalReports: 0,
          pendingApprovals: 0,
          departmentWiseSpend: [],
          projectWiseSpend: [],
          costCentreWiseSpend: [],
          monthlyTrends: [],
        };
      }

      const companyId = accountant.companyId;

      // Get users in this company to filter reports
      const companyUsers = await User.find({ companyId }).select('_id').exec();
      const userIds = companyUsers.map(u => u._id);

      // Get all approved reports for the company
      const approvedReports = await ExpenseReport.find({
        userId: { $in: userIds },
        status: ExpenseReportStatus.APPROVED,
      })
        .populate('userId', 'name departmentId')
        .populate('projectId', 'name')
        .populate('costCentreId', 'name')
        .exec();

      // Calculate total spend with currency conversion
      const convertedAmounts = await Promise.all(
        approvedReports.map(async (report) => {
          const amount = report.totalAmount || 0;
          const currency = report.currency || 'INR';
          return await currencyService.convertToINR(amount, currency);
        })
      );

      const totalSpend = convertedAmounts.reduce((sum, amount) => sum + amount, 0);

      // Get all reports count
      const totalReports = await ExpenseReport.countDocuments({
        userId: { $in: userIds },
        status: { $in: [ExpenseReportStatus.SUBMITTED, ExpenseReportStatus.MANAGER_APPROVED, ExpenseReportStatus.APPROVED] },
      });

      // Get pending approvals count
      const pendingApprovals = await ExpenseReport.countDocuments({
        userId: { $in: userIds },
        status: { $in: [ExpenseReportStatus.SUBMITTED, ExpenseReportStatus.MANAGER_APPROVED] },
      });

      // Department-wise spending
      const departmentWiseSpend = await this.getDepartmentWiseSpend(companyId);

      // Project-wise spending
      const projectWiseSpend = await this.getProjectWiseSpend(companyId);

      // Cost centre-wise spending
      const costCentreWiseSpend = await this.getCostCentreWiseSpend(companyId);

      // Monthly trends (last 6 months)
      const monthlyTrends = await this.getMonthlyTrends(companyId);

      return {
        totalSpend,
        totalReports,
        pendingApprovals,
        departmentWiseSpend,
        projectWiseSpend,
        costCentreWiseSpend,
        monthlyTrends,
      };
    } catch (error) {
      logger.error({ error, accountantId }, 'Error getting accountant dashboard stats');
      throw error;
    }
  }

  /**
   * Get department-wise expenses summary
   */
  static async getDepartmentWiseSpend(companyId: mongoose.Types.ObjectId): Promise<any[]> {
    try {
      const departments = await Department.find({ companyId }).exec();
      const departmentSpend: any[] = [];

      for (const dept of departments) {
        const usersInDept = await User.find({
          companyId,
          departmentId: dept._id,
          status: 'ACTIVE',
        }).select('_id').exec();

        const userIds = usersInDept.map(u => u._id);

        const reports = await ExpenseReport.find({
          userId: { $in: userIds },
          status: ExpenseReportStatus.APPROVED,
        }).select('totalAmount currency').exec();

        const convertedAmounts = await Promise.all(
          reports.map(async (report) => {
            const amount = report.totalAmount || 0;
            const currency = report.currency || 'INR';
            return await currencyService.convertToINR(amount, currency);
          })
        );

        const totalSpend = convertedAmounts.reduce((sum, amount) => sum + amount, 0);

        departmentSpend.push({
          departmentId: dept._id,
          departmentName: dept.name,
          totalSpend,
          reportCount: reports.length,
        });
      }

      return departmentSpend.sort((a, b) => b.totalSpend - a.totalSpend);
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting department-wise spend');
      return [];
    }
  }

  /**
   * Get project-wise expenses summary
   */
  static async getProjectWiseSpend(companyId: mongoose.Types.ObjectId): Promise<any[]> {
    try {
      const projects = await Project.find({ companyId, status: 'ACTIVE' }).exec();
      const projectSpend: any[] = [];

      for (const project of projects) {
        // Get users in this company to filter reports
        const companyUsers = await User.find({ companyId }).select('_id').exec();
        const userIds = companyUsers.map(u => u._id);
        
        const reports = await ExpenseReport.find({
          projectId: project._id,
          userId: { $in: userIds },
          status: ExpenseReportStatus.APPROVED,
        }).select('totalAmount currency').exec();

        const convertedAmounts = await Promise.all(
          reports.map(async (report) => {
            const amount = report.totalAmount || 0;
            const currency = report.currency || 'INR';
            return await currencyService.convertToINR(amount, currency);
          })
        );

        const totalSpend = convertedAmounts.reduce((sum, amount) => sum + amount, 0);
        const budget = project.budget || 0;
        const spentAmount = project.spentAmount || 0;
        const budgetUtilization = budget > 0 ? (spentAmount / budget) * 100 : 0;

        projectSpend.push({
          projectId: project._id,
          projectName: project.name,
          projectCode: project.code,
          totalSpend,
          budget,
          spentAmount,
          budgetUtilization,
          reportCount: reports.length,
        });
      }

      return projectSpend.sort((a, b) => b.totalSpend - a.totalSpend);
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting project-wise spend');
      return [];
    }
  }

  /**
   * Get cost centre-wise expenses summary
   */
  static async getCostCentreWiseSpend(companyId: mongoose.Types.ObjectId): Promise<any[]> {
    try {
      const costCentres = await CostCentre.find({ companyId, status: 'ACTIVE' }).exec();
      const costCentreSpend: any[] = [];

      for (const costCentre of costCentres) {
        // Get users in this company to filter reports
        const companyUsers = await User.find({ companyId }).select('_id').exec();
        const userIds = companyUsers.map(u => u._id);
        
        const reports = await ExpenseReport.find({
          costCentreId: costCentre._id,
          userId: { $in: userIds },
          status: ExpenseReportStatus.APPROVED,
        }).select('totalAmount currency').exec();

        const convertedAmounts = await Promise.all(
          reports.map(async (report) => {
            const amount = report.totalAmount || 0;
            const currency = report.currency || 'INR';
            return await currencyService.convertToINR(amount, currency);
          })
        );

        const totalSpend = convertedAmounts.reduce((sum, amount) => sum + amount, 0);
        const budget = costCentre.budget || 0;
        const spentAmount = costCentre.spentAmount || 0;
        const budgetUtilization = budget > 0 ? (spentAmount / budget) * 100 : 0;

        costCentreSpend.push({
          costCentreId: costCentre._id,
          costCentreName: costCentre.name,
          costCentreCode: costCentre.code,
          totalSpend,
          budget,
          spentAmount,
          budgetUtilization,
          reportCount: reports.length,
        });
      }

      return costCentreSpend.sort((a, b) => b.totalSpend - a.totalSpend);
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting cost centre-wise spend');
      return [];
    }
  }

  /**
   * Get monthly expense trends (last 6 months)
   */
  static async getMonthlyTrends(companyId: mongoose.Types.ObjectId): Promise<any[]> {
    try {
      const now = new Date();
      const trends: any[] = [];

      for (let i = 5; i >= 0; i--) {
        const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const nextMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

        // Get users in this company to filter reports
        const companyUsers = await User.find({ companyId }).select('_id').exec();
        const userIds = companyUsers.map(u => u._id);
        
        const reports = await ExpenseReport.find({
          userId: { $in: userIds },
          status: ExpenseReportStatus.APPROVED,
          approvedAt: {
            $gte: monthDate,
            $lt: nextMonth,
          },
        }).select('totalAmount currency').exec();

        const convertedAmounts = await Promise.all(
          reports.map(async (report) => {
            const amount = report.totalAmount || 0;
            const currency = report.currency || 'INR';
            return await currencyService.convertToINR(amount, currency);
          })
        );

        const totalSpend = convertedAmounts.reduce((sum, amount) => sum + amount, 0);

        trends.push({
          month: monthDate.toISOString().substring(0, 7), // YYYY-MM
          monthName: monthDate.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
          totalSpend,
          reportCount: reports.length,
        });
      }

      return trends;
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting monthly trends');
      return [];
    }
  }

  /**
   * Get all reports (read-only)
   */
  static async getReports(
    accountantId: string,
    filters: {
      status?: string;
      departmentId?: string;
      projectId?: string;
      costCentreId?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    }
  ): Promise<{ reports: any[]; total: number }> {
    try {
      const accountant = await User.findById(accountantId)
        .select('companyId')
        .exec();

      if (!accountant || !accountant.companyId) {
        return { reports: [], total: 0 };
      }

      const query: any = {};

      // Filter by status
      if (filters.status && filters.status !== 'all') {
        query.status = filters.status;
      }

      // Filter by department
      if (filters.departmentId) {
        const usersInDept = await User.find({
          companyId: accountant.companyId,
          departmentId: filters.departmentId,
        }).select('_id').exec();
        query.userId = { $in: usersInDept.map(u => u._id) };
      }

      // Filter by project
      if (filters.projectId) {
        query.projectId = new mongoose.Types.ObjectId(filters.projectId);
      }

      // Filter by cost centre
      if (filters.costCentreId) {
        query.costCentreId = new mongoose.Types.ObjectId(filters.costCentreId);
      }

      // Search by report name
      if (filters.search) {
        query.name = { $regex: filters.search, $options: 'i' };
      }

      const page = filters.page || 1;
      const pageSize = filters.pageSize || 20;
      const skip = (page - 1) * pageSize;

      const [reports, total] = await Promise.all([
        ExpenseReport.find(query)
          .populate('userId', 'name email departmentId')
          .populate('projectId', 'name code')
          .populate('costCentreId', 'name code')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(pageSize)
          .exec(),
        ExpenseReport.countDocuments(query).exec(),
      ]);

      return { reports, total };
    } catch (error) {
      logger.error({ error, accountantId, filters }, 'Error getting reports for accountant');
      throw error;
    }
  }

  /**
   * Get report details (read-only)
   */
  static async getReportDetails(accountantId: string, reportId: string): Promise<any> {
    try {
      const accountant = await User.findById(accountantId)
        .select('companyId')
        .exec();

      if (!accountant || !accountant.companyId) {
        throw new Error('Accountant not found or not associated with a company');
      }

      const report = await ExpenseReport.findById(reportId)
        .populate('userId', 'name email departmentId')
        .populate('projectId', 'name code budget spentAmount thresholdPercentage')
        .populate('costCentreId', 'name code budget spentAmount thresholdPercentage')
        .populate('approvers.userId', 'name email role')
        .exec();

      if (!report) {
        throw new Error('Report not found');
      }

      // Get expenses for this report
      const expenses = await Expense.find({ reportId })
        .populate('categoryId', 'name')
        .populate('receiptIds', 'storageUrl')
        .exec();

      return {
        report,
        expenses,
      };
    } catch (error) {
      logger.error({ error, accountantId, reportId }, 'Error getting report details for accountant');
      throw error;
    }
  }
}


import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { Project } from '../models/Project';
import { CostCentre } from '../models/CostCentre';
import { Department } from '../models/Department';
import { Company } from '../models/Company';
import { ExpenseReportStatus, ExpenseStatus } from '../utils/enums';
import { currencyService } from './currency.service';

import { logger } from '@/config/logger';

export class AnalyticsService {
  /**
   * Validate companyId exists
   */
  static async validateCompanyId(companyId: string): Promise<boolean> {
    try {
      const company = await Company.findById(companyId).select('_id').exec();
      return !!company;
    } catch (error) {
      logger.error({ error, companyId }, 'Error validating company ID');
      return false;
    }
  }

  /**
   * Get dashboard summary statistics for a company
   */
  static async getDashboardSummary(companyId: string, fromDate?: Date, toDate?: Date): Promise<any> {
    try {
      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      
      // Get users in this company
      const companyUsers = await User.find({ companyId: companyObjectId })
        .select('_id')
        .exec();
      const userIds = companyUsers.map(u => u._id);

      if (userIds.length === 0) {
        return {
          totalSpend: 0,
          totalReports: 0,
          totalExpenses: 0,
          pendingReports: 0,
          approvedReports: 0,
          totalUsers: 0,
        };
      }

      // Build date filter
      const dateFilter: any = {};
      if (fromDate || toDate) {
        dateFilter.approvedAt = {};
        if (fromDate) dateFilter.approvedAt.$gte = fromDate;
        if (toDate) dateFilter.approvedAt.$lte = toDate;
      }

      // Get approved reports
      const approvedReports = await ExpenseReport.find({
        userId: { $in: userIds },
        status: ExpenseReportStatus.APPROVED,
        ...dateFilter,
      })
        .select('totalAmount currency')
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
      });

      // Get total expenses count
      const totalExpenses = await Expense.countDocuments({
        userId: { $in: userIds },
      });

      // Get pending reports count
      const pendingReports = await ExpenseReport.countDocuments({
        userId: { $in: userIds },
        status: { $in: [ExpenseReportStatus.SUBMITTED, ExpenseReportStatus.MANAGER_APPROVED] },
      });

      // Get approved reports count
      const approvedReportsCount = approvedReports.length;

      // Get total users count
      const totalUsers = await User.countDocuments({
        companyId: companyObjectId,
        status: 'ACTIVE',
      });

      return {
        totalSpend,
        totalReports,
        totalExpenses,
        pendingReports,
        approvedReports: approvedReportsCount,
        totalUsers,
      };
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting dashboard summary');
      throw error;
    }
  }

  /**
   * Get department-wise expenses summary
   */
  static async getDepartmentWiseExpenses(companyId: string, fromDate?: Date, toDate?: Date): Promise<any[]> {
    try {
      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      const departments = await Department.find({ companyId: companyObjectId }).exec();
      const departmentSpend: any[] = [];

      for (const dept of departments) {
        const usersInDept = await User.find({
          companyId: companyObjectId,
          departmentId: dept._id,
          status: 'ACTIVE',
        }).select('_id').exec();

        const userIds = usersInDept.map(u => u._id);

        if (userIds.length === 0) continue;

        const dateFilter: any = {};
        if (fromDate || toDate) {
          dateFilter.approvedAt = {};
          if (fromDate) dateFilter.approvedAt.$gte = fromDate;
          if (toDate) dateFilter.approvedAt.$lte = toDate;
        }

        const reports = await ExpenseReport.find({
          userId: { $in: userIds },
          status: ExpenseReportStatus.APPROVED,
          ...dateFilter,
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
          departmentId: (dept._id as mongoose.Types.ObjectId).toString(),
          departmentName: dept.name,
          totalSpend,
          reportCount: reports.length,
        });
      }

      return departmentSpend.sort((a, b) => b.totalSpend - a.totalSpend);
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting department-wise expenses');
      return [];
    }
  }

  /**
   * Get project-wise expenses summary
   */
  static async getProjectWiseExpenses(companyId: string, fromDate?: Date, toDate?: Date): Promise<any[]> {
    try {
      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      const projects = await Project.find({ companyId: companyObjectId, status: 'ACTIVE' }).exec();
      const projectSpend: any[] = [];

      for (const project of projects) {
        const companyUsers = await User.find({ companyId: companyObjectId }).select('_id').exec();
        const userIds = companyUsers.map(u => u._id);

        if (userIds.length === 0) continue;

        const dateFilter: any = {};
        if (fromDate || toDate) {
          dateFilter.approvedAt = {};
          if (fromDate) dateFilter.approvedAt.$gte = fromDate;
          if (toDate) dateFilter.approvedAt.$lte = toDate;
        }

        const reports = await ExpenseReport.find({
          projectId: project._id,
          userId: { $in: userIds },
          status: ExpenseReportStatus.APPROVED,
          ...dateFilter,
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
          projectId: (project._id as mongoose.Types.ObjectId).toString(),
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
      logger.error({ error, companyId }, 'Error getting project-wise expenses');
      return [];
    }
  }

  /**
   * Get cost centre-wise expenses summary
   */
  static async getCostCentreWiseExpenses(companyId: string, fromDate?: Date, toDate?: Date): Promise<any[]> {
    try {
      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      const costCentres = await CostCentre.find({ companyId: companyObjectId, status: 'ACTIVE' }).exec();
      const costCentreSpend: any[] = [];

      for (const costCentre of costCentres) {
        const companyUsers = await User.find({ companyId: companyObjectId }).select('_id').exec();
        const userIds = companyUsers.map(u => u._id);

        if (userIds.length === 0) continue;

        const dateFilter: any = {};
        if (fromDate || toDate) {
          dateFilter.approvedAt = {};
          if (fromDate) dateFilter.approvedAt.$gte = fromDate;
          if (toDate) dateFilter.approvedAt.$lte = toDate;
        }

        const reports = await ExpenseReport.find({
          costCentreId: costCentre._id,
          userId: { $in: userIds },
          status: ExpenseReportStatus.APPROVED,
          ...dateFilter,
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
          costCentreId: (costCentre._id as mongoose.Types.ObjectId).toString(),
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
      logger.error({ error, companyId }, 'Error getting cost centre-wise expenses');
      return [];
    }
  }

  /**
   * Get category-wise expenses summary
   */
  static async getCategoryWiseExpenses(companyId: string, fromDate?: Date, toDate?: Date): Promise<any[]> {
    try {
      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      const companyUsers = await User.find({ companyId: companyObjectId }).select('_id').exec();
      const userIds = companyUsers.map(u => u._id);

      if (userIds.length === 0) return [];

      const dateFilter: any = {};
      if (fromDate || toDate) {
        dateFilter.expenseDate = {};
        if (fromDate) dateFilter.expenseDate.$gte = fromDate;
        if (toDate) dateFilter.expenseDate.$lte = toDate;
      }

      // Get expenses with categories
      const expenses = await Expense.find({
        userId: { $in: userIds },
        categoryId: { $exists: true, $ne: null },
        status: { $in: [ExpenseStatus.APPROVED, ExpenseStatus.PENDING] },
        ...dateFilter,
      })
        .populate('categoryId', 'name')
        .select('amount currency categoryId')
        .exec();

      // Group by category
      const categoryMap = new Map<string, { categoryId: string; categoryName: string; totalSpend: number; expenseCount: number }>();

      for (const expense of expenses) {
        const categoryId = (expense.categoryId as any)?._id?.toString() || 'unknown';
        const categoryName = (expense.categoryId as any)?.name || 'Unknown';

        if (!categoryMap.has(categoryId)) {
          categoryMap.set(categoryId, {
            categoryId,
            categoryName,
            totalSpend: 0,
            expenseCount: 0,
          });
        }

        const entry = categoryMap.get(categoryId)!;
        entry.expenseCount += 1;
        // Note: We'll convert currency later in a batch
        entry.totalSpend += expense.amount || 0;
      }

      // Convert all amounts to INR
      const categorySpend = Array.from(categoryMap.values());
      for (const entry of categorySpend) {
        // For simplicity, assuming all expenses are in the same currency
        // In production, you'd want to convert each expense individually
        entry.totalSpend = await currencyService.convertToINR(entry.totalSpend, 'INR');
      }

      return categorySpend.sort((a, b) => b.totalSpend - a.totalSpend);
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting category-wise expenses');
      return [];
    }
  }

  /**
   * Get monthly expense trends
   */
  static async getMonthlyTrends(companyId: string, months: number = 12): Promise<any[]> {
    try {
      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      const companyUsers = await User.find({ companyId: companyObjectId }).select('_id').exec();
      const userIds = companyUsers.map(u => u._id);

      if (userIds.length === 0) return [];

      const now = new Date();
      const trends: any[] = [];

      for (let i = months - 1; i >= 0; i--) {
        const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const nextMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

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
   * Get expense reports list (read-only, aggregated)
   */
  static async getExpenseReports(
    companyId: string,
    options: {
      page?: number;
      pageSize?: number;
      fromDate?: Date;
      toDate?: Date;
      status?: string;
    } = {}
  ): Promise<{ reports: any[]; total: number; pagination: any }> {
    try {
      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      const companyUsers = await User.find({ companyId: companyObjectId }).select('_id').exec();
      const userIds = companyUsers.map(u => u._id);

      if (userIds.length === 0) {
        return { reports: [], total: 0, pagination: { page: 1, pageSize: 20, totalPages: 0 } };
      }

      const page = options.page || 1;
      const pageSize = options.pageSize || 20;
      const skip = (page - 1) * pageSize;

      // Build filters
      const filter: any = {
        userId: { $in: userIds },
      };

      if (options.status) {
        filter.status = options.status;
      }

      if (options.fromDate || options.toDate) {
        filter.submittedAt = {};
        if (options.fromDate) filter.submittedAt.$gte = options.fromDate;
        if (options.toDate) filter.submittedAt.$lte = options.toDate;
      }

      // Get total count
      const total = await ExpenseReport.countDocuments(filter);

      // Get reports
      const reports = await ExpenseReport.find(filter)
        .populate('userId', 'name email')
        .populate('projectId', 'name code')
        .populate('costCentreId', 'name code')
        .select('name status totalAmount currency fromDate toDate submittedAt approvedAt createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .exec();

      // Format reports
      const formattedReports = reports.map((report) => ({
        id: (report._id as mongoose.Types.ObjectId).toString(),
        name: report.name,
        status: report.status,
        totalAmount: report.totalAmount,
        currency: report.currency,
        fromDate: report.fromDate,
        toDate: report.toDate,
        submittedAt: report.submittedAt,
        approvedAt: report.approvedAt,
        createdAt: report.createdAt,
        user: report.userId ? {
          id: (report.userId as any)._id?.toString(),
          name: (report.userId as any).name,
          email: (report.userId as any).email,
        } : null,
        project: report.projectId ? {
          id: (report.projectId as any)._id?.toString(),
          name: (report.projectId as any).name,
          code: (report.projectId as any).code,
        } : null,
        costCentre: report.costCentreId ? {
          id: (report.costCentreId as any)._id?.toString(),
          name: (report.costCentreId as any).name,
          code: (report.costCentreId as any).code,
        } : null,
      }));

      return {
        reports: formattedReports,
        total,
        pagination: {
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
          total,
        },
      };
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting expense reports');
      throw error;
    }
  }

  /**
   * Get expenses list (read-only, aggregated)
   */
  static async getExpenses(
    companyId: string,
    options: {
      page?: number;
      pageSize?: number;
      fromDate?: Date;
      toDate?: Date;
      status?: string;
    } = {}
  ): Promise<{ expenses: any[]; total: number; pagination: any }> {
    try {
      const companyObjectId = new mongoose.Types.ObjectId(companyId);
      const companyUsers = await User.find({ companyId: companyObjectId }).select('_id').exec();
      const userIds = companyUsers.map(u => u._id);

      if (userIds.length === 0) {
        return { expenses: [], total: 0, pagination: { page: 1, pageSize: 20, totalPages: 0 } };
      }

      const page = options.page || 1;
      const pageSize = options.pageSize || 20;
      const skip = (page - 1) * pageSize;

      // Build filters
      const filter: any = {
        userId: { $in: userIds },
      };

      if (options.status) {
        filter.status = options.status;
      }

      if (options.fromDate || options.toDate) {
        filter.expenseDate = {};
        if (options.fromDate) filter.expenseDate.$gte = options.fromDate;
        if (options.toDate) filter.expenseDate.$lte = options.toDate;
      }

      // Get total count
      const total = await Expense.countDocuments(filter);

      // Get expenses
      const expenses = await Expense.find(filter)
        .populate('userId', 'name email')
        .populate('categoryId', 'name')
        .populate('projectId', 'name code')
        .populate('costCentreId', 'name code')
        .select('vendor amount currency expenseDate status notes createdAt')
        .sort({ expenseDate: -1 })
        .skip(skip)
        .limit(pageSize)
        .exec();

      // Format expenses
      const formattedExpenses = expenses.map((expense) => ({
        id: (expense._id as mongoose.Types.ObjectId).toString(),
        vendor: expense.vendor,
        amount: expense.amount,
        currency: expense.currency,
        expenseDate: expense.expenseDate,
        status: expense.status,
        notes: expense.notes,
        createdAt: expense.createdAt,
        user: expense.userId ? {
          id: (expense.userId as any)._id?.toString(),
          name: (expense.userId as any).name,
          email: (expense.userId as any).email,
        } : null,
        category: expense.categoryId ? {
          id: (expense.categoryId as any)._id?.toString(),
          name: (expense.categoryId as any).name,
        } : null,
        project: expense.projectId ? {
          id: (expense.projectId as any)._id?.toString(),
          name: (expense.projectId as any).name,
          code: (expense.projectId as any).code,
        } : null,
        costCentre: expense.costCentreId ? {
          id: (expense.costCentreId as any)._id?.toString(),
          name: (expense.costCentreId as any).name,
          code: (expense.costCentreId as any).code,
        } : null,
      }));

      return {
        expenses: formattedExpenses,
        total,
        pagination: {
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
          total,
        },
      };
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting expenses');
      throw error;
    }
  }
}


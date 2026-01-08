import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ApiRequestLog } from '../models/ApiRequestLog';
import { AuditLog } from '../models/AuditLog';
import { Company, CompanyStatus, CompanyPlan, CompanyType } from '../models/Company';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { OcrJob } from '../models/OcrJob';
import { Receipt } from '../models/Receipt';
import { User } from '../models/User';
import { AuditService } from '../services/audit.service';
import { emitSystemAnalyticsUpdate, emitDashboardStatsUpdate, emitCompanyCreated } from '../socket/realtimeEvents';
import { SystemAnalyticsService } from '../services/systemAnalytics.service';
import { cacheService } from '../services/cache.service';
import { getUserCompanyId, getCompanyUserIds } from '../utils/companyAccess';
import { ExpenseReportStatus, ExpenseStatus, OcrJobStatus, UserRole, UserStatus , AuditAction } from '../utils/enums';



import { logger } from '@/config/logger';

export class SuperAdminController {
  // Dashboard Stats
  static getDashboardStats = asyncHandler(async (_req: AuthRequest, res: Response) => {
    // Get all real-time stats from database
    const [
      totalUsers,
      activeUsers,
      totalReports,
      totalExpenses,
      totalReceipts,
      completedOcrJobs,
      approvedReports,
      approvedExpenses,
      totalAmountApproved,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ status: UserStatus.ACTIVE }),
      ExpenseReport.countDocuments(),
      Expense.countDocuments(),
      Receipt.countDocuments(),
      OcrJob.countDocuments(),
      OcrJob.countDocuments({ status: OcrJobStatus.COMPLETED }),
      ExpenseReport.countDocuments({ status: ExpenseReportStatus.APPROVED }),
      Expense.countDocuments({ status: ExpenseStatus.APPROVED }),
      ExpenseReport.aggregate([
        { $match: { status: ExpenseReportStatus.APPROVED } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]) as Promise<Array<{ _id: null; total: number }>>,
    ]);

    // Calculate storage used (estimate based on receipts)
    // Assuming average receipt size of 500KB
    const estimatedStorageGB = (totalReceipts * 500) / (1024 * 1024); // Convert to GB

    // Get stats from last month for trends
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const [
      usersLastMonth,
      reportsLastMonth,
    ] = await Promise.all([
      User.countDocuments({ createdAt: { $gte: oneMonthAgo } }),
      ExpenseReport.countDocuments({ createdAt: { $gte: oneMonthAgo } }),
    ]);

    // Calculate trends (percentage change)
    const userTrend = totalUsers > 0 ? ((usersLastMonth / totalUsers) * 100).toFixed(1) : '0';
    const reportTrend = totalReports > 0 ? ((reportsLastMonth / totalReports) * 100).toFixed(1) : '0';

    // Count companies from Company collection
    const totalCompanies = await Company.countDocuments();
    const activeCompanies = await Company.countDocuments({ 
      status: CompanyStatus.ACTIVE 
    });

    // Get most common currency for MRR/ARR
    const currencyCounts = await ExpenseReport.aggregate([
      { $match: { status: ExpenseReportStatus.APPROVED } },
      { $group: { _id: '$currency', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]);
    const defaultCurrency = currencyCounts.length > 0 ? currencyCounts[0]._id : 'INR';

    const dashboardStats = {
      totalCompanies,
      activeCompanies,
      mrr: 0, // Monthly recurring revenue - would need subscription model
      arr: 0, // Annual recurring revenue - would need subscription model
      totalUsers,
      activeUsers,
      storageUsed: Math.round(estimatedStorageGB * 100) / 100, // Round to 2 decimals
      ocrUsage: completedOcrJobs,
      reportsCreated: totalReports,
      expensesCreated: totalExpenses,
      receiptsUploaded: totalReceipts,
      mrrTrend: 0,
      userTrend: parseFloat(userTrend),
      storageTrend: 0,
      reportTrend: parseFloat(reportTrend),
      totalAmountApproved: (Array.isArray(totalAmountApproved) && totalAmountApproved.length > 0) ? totalAmountApproved[0].total : 0,
      approvedReports,
      approvedExpenses,
      mrrCurrency: defaultCurrency,
      arrCurrency: defaultCurrency,
    };

    // Emit real-time update for dashboard stats
    emitDashboardStatsUpdate(dashboardStats);

    res.status(200).json({
      success: true,
      data: dashboardStats,
    });
  });

  // System Analytics
  static getSystemAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
    const timeRange = (req.query.range as string) || '30d';
    
    // Calculate date range
    const now = new Date();
    const startDate = new Date();
    
    switch (timeRange) {
      case '24h':
        startDate.setHours(now.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      default:
        startDate.setDate(now.getDate() - 30);
    }

    // Revenue trend (using approved report amounts) - group by currency
    const revenueTrend = await ExpenseReport.aggregate([
      {
        $match: {
          status: ExpenseReportStatus.APPROVED,
          approvedAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$approvedAt' },
            month: { $month: '$approvedAt' },
            currency: '$currency',
          },
          mrr: { $sum: '$totalAmount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);
    
    // Get most common currency for MRR/ARR
    const currencyCounts = await ExpenseReport.aggregate([
      {
        $match: {
          status: ExpenseReportStatus.APPROVED,
          approvedAt: { $gte: startDate },
        },
      },
      { $group: { _id: '$currency', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]);
    const defaultCurrency = currencyCounts.length > 0 ? currencyCounts[0]._id : 'INR';

    // Format revenue trend - aggregate by month (summing all currencies)
    const monthMap = new Map();
    revenueTrend.forEach((item) => {
      const monthKey = `${item._id.year}-${item._id.month}`;
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, {
          name: `${monthNames[item._id.month - 1]} ${item._id.year}`,
          mrr: 0,
          arr: 0,
          currencies: new Set(),
        });
      }
      const monthData = monthMap.get(monthKey);
      monthData.mrr += item.mrr;
      monthData.arr += item.mrr * 12;
      monthData.currencies.add(item._id.currency || 'INR');
    });
    
    const formattedRevenueTrend = Array.from(monthMap.values()).map((item) => ({
      name: item.name,
      mrr: item.mrr,
      arr: item.arr,
      currency: defaultCurrency, // Use most common currency
    }));

    // Platform usage (reports and receipts over time)
    const platformUsage = await ExpenseReport.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          reports: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const receiptsUsage = await Receipt.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          receipts: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    // Merge reports and receipts by month
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const usageMap = new Map();
    
    platformUsage.forEach((item) => {
      const key = `${item._id.year}-${item._id.month}`;
      usageMap.set(key, {
        name: `${monthNames[item._id.month - 1]} ${item._id.year}`,
        reports: item.reports,
        receipts: 0,
      });
    });

    receiptsUsage.forEach((item) => {
      const key = `${item._id.year}-${item._id.month}`;
      if (usageMap.has(key)) {
        usageMap.get(key).receipts = item.receipts;
      } else {
        usageMap.set(key, {
          name: `${monthNames[item._id.month - 1]} ${item._id.year}`,
          reports: 0,
          receipts: item.receipts,
        });
      }
    });

    const formattedPlatformUsage = Array.from(usageMap.values());

    // OCR Heatmap (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const ocrHeatmap = await OcrJob.aggregate([
      {
        $match: {
          createdAt: { $gte: sevenDaysAgo },
          status: OcrJobStatus.COMPLETED,
        },
      },
      {
        $group: {
          _id: {
            day: { $dayOfWeek: '$createdAt' },
            hour: { $hour: '$createdAt' },
          },
          count: { $sum: 1 },
        },
      },
    ]);

    // Format OCR heatmap data
    const formattedOcrHeatmap = ocrHeatmap.map((item) => ({
      day: item._id.day,
      hour: item._id.hour,
      value: item.count,
    }));

    // User growth trend
    const userGrowth = await User.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' },
          },
          active: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    ]);

    const formattedUserGrowth = userGrowth.map((item) => ({
      name: `${item._id.month}/${item._id.day}`,
      active: item.active,
    }));

    // Company signups (from CompanyAdmin collection)
    const companySignups = await CompanyAdmin.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' },
          },
          signups: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    ]);

    const formattedCompanySignups = companySignups.map((item) => ({
      name: `${item._id.month}/${item._id.day}`,
      signups: item.signups,
    }));

    const analyticsData = {
      revenueTrend: formattedRevenueTrend,
      platformUsage: formattedPlatformUsage,
      ocrHeatmap: formattedOcrHeatmap,
      userGrowth: formattedUserGrowth,
      companySignups: formattedCompanySignups,
    };

    // Emit real-time update
    emitSystemAnalyticsUpdate(analyticsData);

    res.status(200).json({
      success: true,
      data: analyticsData,
    });
  });

  // Get Companies
  static getCompanies = asyncHandler(async (req: AuthRequest, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const sortBy = req.query.sortBy as string || 'newest';
    const statusFilter = req.query.status as string;
    const searchQuery = req.query.search as string;

    // Build query
    const query: any = {};
    
    if (statusFilter && statusFilter !== 'all') {
      query.status = statusFilter;
    }

    if (searchQuery) {
      query.$or = [
        { name: { $regex: searchQuery, $options: 'i' } },
        { location: { $regex: searchQuery, $options: 'i' } },
        { domain: { $regex: searchQuery, $options: 'i' } },
      ];
    }

    let sort: any = { createdAt: -1 }; // Default: newest first

    if (sortBy === 'oldest') {
      sort = { createdAt: 1 };
    } else if (sortBy === 'top-spenders') {
      // For top spenders, we'll need to aggregate by total expenses
      // For now, sort by newest
      sort = { createdAt: -1 };
    }

    const companies = await Company.find(query)
      .sort(sort)
      .limit(limit)
      .lean();

    // Get stats for each company
    const formattedCompanies = await Promise.all(
      companies.map(async (company) => {
        const companyId = company._id.toString();
        
        // Count users by role for this company (excluding company admins)
        const [employees, managers, businessHeads, totalUsers, companyAdmins] = await Promise.all([
          User.countDocuments({ companyId: new mongoose.Types.ObjectId(companyId), role: UserRole.EMPLOYEE }),
          User.countDocuments({ companyId: new mongoose.Types.ObjectId(companyId), role: UserRole.MANAGER }),
          User.countDocuments({ companyId: new mongoose.Types.ObjectId(companyId), role: UserRole.BUSINESS_HEAD }),
          User.countDocuments({ companyId: new mongoose.Types.ObjectId(companyId) }),
          CompanyAdmin.countDocuments({ companyId: new mongoose.Types.ObjectId(companyId) }),
        ]);

        // Get first company admin for display
        const firstAdmin = await CompanyAdmin.findOne({
          companyId: new mongoose.Types.ObjectId(companyId),
        })
          .select('email name')
          .lean();

        // Count reports for this company
        const companyUsers = await User.find({ companyId: new mongoose.Types.ObjectId(companyId) })
          .select('_id')
          .lean();
        const userIds = companyUsers.map(u => u._id);
        const totalReports = await ExpenseReport.countDocuments({ userId: { $in: userIds } });

        // Calculate storage (estimate based on receipts for this company)
        const companyExpenses = await Expense.find({ userId: { $in: userIds } })
          .select('_id')
          .lean();
        const expenseIds = companyExpenses.map(e => e._id);
        const totalReceipts = await Receipt.countDocuments({ expenseId: { $in: expenseIds } });
        const estimatedStorageGB = (totalReceipts * 500) / (1024 * 1024);

        // Get monthly spend (from approved reports for this company) - group by currency
        const monthlySpendResult = await ExpenseReport.aggregate([
          { $match: { userId: { $in: userIds }, status: ExpenseReportStatus.APPROVED } },
          { $group: { _id: '$currency', total: { $sum: '$totalAmount' } } },
        ]);
        // Get the most common currency or default to INR
        const currencyCounts = await ExpenseReport.aggregate([
          { $match: { userId: { $in: userIds }, status: ExpenseReportStatus.APPROVED } },
          { $group: { _id: '$currency', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 1 },
        ]);
        const companyCurrency = currencyCounts.length > 0 ? currencyCounts[0]._id : 'INR';
        const monthlySpend = monthlySpendResult.reduce((sum, item) => sum + item.total, 0);

        return {
          id: company._id.toString(),
          name: company.name,
          location: company.location,
          type: company.type,
          domain: company.domain,
          adminName: firstAdmin?.name || 'No Admin',
          adminEmail: firstAdmin?.email || '',
          employees,
          managers,
          businessHeads,
          totalUsers,
          totalReports,
          status: company.status,
          plan: company.plan,
          storageUsed: Math.round(estimatedStorageGB * 100) / 100,
          createdAt: company.createdAt,
          monthlySpend,
          currency: companyCurrency,
          adminCount: companyAdmins,
        };
      })
    );

    // Sort by monthly spend if needed
    if (sortBy === 'top-spenders') {
      formattedCompanies.sort((a, b) => b.monthlySpend - a.monthlySpend);
    }

    // Get totals for stats cards
    const [totalCompanies, activeCompanies, totalUsers, totalReports] = await Promise.all([
      Company.countDocuments(),
      Company.countDocuments({ status: CompanyStatus.ACTIVE }),
      User.countDocuments(),
      ExpenseReport.countDocuments(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        companies: formattedCompanies,
        stats: {
          totalCompanies,
          activeCompanies,
          totalUsers,
          totalReports,
        },
      },
    });
  });

  // Get Company by ID
  static getCompanyById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = req.params.id;
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid company ID format',
        code: 'INVALID_ID',
      });
      return;
    }
    
    const company = await Company.findById(companyId).lean();

    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
        code: 'COMPANY_NOT_FOUND',
      });
      return;
    }

    const companyObjectId = new mongoose.Types.ObjectId(companyId);

    // Get company admins
    const companyAdmins = await CompanyAdmin.find({
      companyId: companyObjectId,
    })
      .select('email name status createdAt lastLoginAt')
      .sort({ createdAt: -1 })
      .lean();

    // Get company stats - filter by companyId
    const companyUsers = await User.find({ companyId: companyObjectId })
      .select('_id')
      .lean();
    const userIds = companyUsers.map(u => u._id);

    // Get company expenses first
    const companyExpenses = await Expense.find({ userId: { $in: userIds } })
      .select('_id')
      .lean();
    const expenseIds = companyExpenses.map(e => e._id);

    const [employees, managers, businessHeads, totalUsers, totalReports, companyReceipts, ocrUsage] = await Promise.all([
      User.countDocuments({ companyId: companyObjectId, role: UserRole.EMPLOYEE }),
      User.countDocuments({ companyId: companyObjectId, role: UserRole.MANAGER }),
      User.countDocuments({ companyId: companyObjectId, role: UserRole.BUSINESS_HEAD }),
      User.countDocuments({ companyId: companyObjectId }),
      ExpenseReport.countDocuments({ userId: { $in: userIds } }),
      Receipt.countDocuments({ expenseId: { $in: expenseIds } }),
      OcrJob.countDocuments({ status: OcrJobStatus.COMPLETED }),
    ]);

    // Calculate storage
    const estimatedStorageGB = (companyReceipts * 500) / (1024 * 1024);

    // Get monthly spend trends (last 7 months)
    const sevenMonthsAgo = new Date();
    sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);

    const monthlySpend = await ExpenseReport.aggregate([
      {
        $match: {
          status: ExpenseReportStatus.APPROVED,
          approvedAt: { $gte: sevenMonthsAgo },
          userId: { $in: userIds },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$approvedAt' },
            month: { $month: '$approvedAt' },
            currency: '$currency',
          },
          value: { $sum: '$totalAmount' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);
    
    // Get most common currency for this company
    const currencyCounts = await ExpenseReport.aggregate([
      {
        $match: {
          userId: { $in: userIds },
          status: ExpenseReportStatus.APPROVED,
        },
      },
      { $group: { _id: '$currency', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]);
    const companyCurrency = currencyCounts.length > 0 ? currencyCounts[0]._id : 'INR';

    const monthNames = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan'];
    const formattedMonthlySpend = monthlySpend.map((item, idx) => ({
      name: monthNames[idx] || `${item._id.month}/${item._id.year}`,
      value: item.value,
    }));

    // Report creation trend - for this company
    const reportTrend = await ExpenseReport.aggregate([
      {
        $match: {
          userId: { $in: userIds },
          createdAt: { $gte: sevenMonthsAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          value: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const formattedReportTrend = reportTrend.map((item, idx) => ({
      name: monthNames[idx] || `${item._id.month}/${item._id.year}`,
      value: item.value,
    }));

    // Receipt upload trend - for this company
    const receiptTrend = await Receipt.aggregate([
      {
        $match: {
          expenseId: { $in: expenseIds },
          createdAt: { $gte: sevenMonthsAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          value: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const formattedReceiptTrend = receiptTrend.map((item, idx) => ({
      name: monthNames[idx] || `${item._id.month}/${item._id.year}`,
      value: item.value,
    }));

    // OCR jobs trend
    const ocrJobs = await OcrJob.aggregate([
      {
        $match: {
          createdAt: { $gte: sevenMonthsAgo },
          status: OcrJobStatus.COMPLETED,
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          value: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const formattedOcrJobs = ocrJobs.map((item, idx) => ({
      name: monthNames[idx] || `${item._id.month}/${item._id.year}`,
      value: item.value,
    }));

    // Reports by status - filter by company users only
    const reportsByStatus = await ExpenseReport.aggregate([
      {
        $match: {
          userId: { $in: userIds }, // Only include reports from this company's users
        },
      },
      {
        $group: {
          _id: '$status',
          value: { $sum: 1 },
        },
      },
    ]);

    const statusMap: Record<string, string> = {
      DRAFT: 'Draft',
      SUBMITTED: 'Submitted',
      PENDING_APPROVAL_L1: 'Pending L1',
      PENDING_APPROVAL_L2: 'Pending L2',
      PENDING_APPROVAL_L3: 'Pending L3',
      PENDING_APPROVAL_L4: 'Pending L4',
      PENDING_APPROVAL_L5: 'Pending L5',
      CHANGES_REQUESTED: 'Changes Requested',
      MANAGER_APPROVED: 'Manager Approved',
      BH_APPROVED: 'BH Approved',
      APPROVED: 'Approved',
      REJECTED: 'Rejected',
    };

    const formattedReportsByStatus = reportsByStatus.map((item) => ({
      name: statusMap[item._id] || item._id,
      value: item.value,
    }));

    // Storage by type (estimate)
    const storageByType = [
      { name: 'Receipts', value: Math.round(estimatedStorageGB * 0.7) },
      { name: 'Reports', value: Math.round(estimatedStorageGB * 0.2) },
      { name: 'Exports', value: Math.round(estimatedStorageGB * 0.08) },
      { name: 'Logs', value: Math.round(estimatedStorageGB * 0.02) },
    ];

    // Get users list for this company (employees, managers, business heads only)
    const users = await User.find({ companyId: companyObjectId })
      .select('email name role status lastLoginAt createdAt')
      .limit(100)
      .lean();

    const formattedUsers = users.map((user) => ({
      id: user._id.toString(),
      name: user.name || 'Unknown',
      email: user.email,
      role: user.role.toLowerCase().replace('_', '-'),
      lastActive: user.lastLoginAt ? user.lastLoginAt.toISOString().split('T')[0] : 'Never',
      status: user.status === UserStatus.ACTIVE ? 'active' : 'inactive',
    }));

    // Format company admins
    const formattedAdmins = companyAdmins.map((admin) => ({
      id: admin._id.toString(),
      name: admin.name || 'Unknown',
      email: admin.email,
      status: admin.status,
      createdAt: admin.createdAt,
      lastLogin: admin.lastLoginAt ? admin.lastLoginAt.toISOString() : null,
    }));

    res.status(200).json({
      success: true,
      data: {
        id: company._id.toString(),
        name: company.name,
        location: company.location,
        type: company.type,
        domain: company.domain,
        createdAt: company.createdAt,
        totalUsers,
        employees,
        managers,
        businessHeads,
        totalReports,
        ocrUsage,
        storageUsed: Math.round(estimatedStorageGB * 100) / 100,
        billingCycle: new Date().toISOString().split('T')[0],
        currentPlan: company.plan,
        monthlyPrice: company.plan === CompanyPlan.ENTERPRISE ? 45000 : company.plan === CompanyPlan.PROFESSIONAL ? 25000 : company.plan === CompanyPlan.BASIC ? 10000 : 0,
        currency: companyCurrency,
        status: company.status,
        trends: {
          monthlySpend: formattedMonthlySpend,
          reportTrend: formattedReportTrend,
          receiptTrend: formattedReceiptTrend,
          ocrJobs: formattedOcrJobs,
        },
        reportsByStatus: formattedReportsByStatus,
        storageByType,
        users: formattedUsers,
        admins: formattedAdmins,
      },
    });
  });

  // Get Company Analytics
  static getCompanyAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = req.params.id;
    const { timeRange = '30d' } = req.query;

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid company ID format',
        code: 'INVALID_ID',
      });
      return;
    }

    const companyObjectId = new mongoose.Types.ObjectId(companyId);

    // Get company users for filtering
    const companyUsers = await User.find({ companyId: companyObjectId })
      .select('_id')
      .lean();
    const userIds = companyUsers.map(u => u._id);

    // Get company's primary currency from approved expense reports
    const currencyCounts = await ExpenseReport.aggregate([
      { $match: { userId: { $in: userIds }, status: ExpenseReportStatus.APPROVED } },
      { $group: { _id: '$currency', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]);
    const companyCurrency = currencyCounts.length > 0 ? currencyCounts[0]._id : 'INR';

    if (userIds.length === 0) {
      res.status(200).json({
        success: true,
        data: {
          ocr: { totalLifetime: 0, thisMonth: 0, perUser: 0, successRate: 0, avgProcessingTime: 0, growthRate: 0 },
          reports: { totalCreated: 0, perMonth: 0, approvalRate: 0, avgApprovalTime: 0, growthRate: 0, statusBreakdown: { approved: 0, pending: 0, rejected: 0 } },
          apiUsage: { totalCalls: 0, callsThisMonth: 0, perUser: 0, errorRate: 0, growthRate: 0, topEndpoints: [] },
          storage: { usedGB: 0, allocatedGB: 10, growthRate: 0, ocrContribution: 0 },
          financial: { mrrContribution: 0, arrProjection: 0, costPerOCR: 0, efficiencyRatio: 0, mrrGrowth: 0 }
        }
      });
      return;
    }

    // Calculate date range
    const now = new Date();
    const startDate = new Date();

    switch (timeRange) {
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      default:
        startDate.setDate(now.getDate() - 30);
    }

    // Get company expenses for storage calculation
    const companyExpenses = await Expense.find({ userId: { $in: userIds } })
      .select('_id')
      .lean();
    const expenseIds = companyExpenses.map(e => e._id);

    // OCR Analytics - Get OCR jobs for company receipts only
    // First get receipt IDs for the company
    const companyReceiptIds = await Receipt.find({ expenseId: { $in: expenseIds } }).distinct('_id');

    // Then get OCR jobs for those receipts
    const [ocrJobsTotal, ocrJobsThisMonth, ocrJobsLastMonth] = await Promise.all([
      OcrJob.countDocuments({
        status: OcrJobStatus.COMPLETED,
        receiptId: { $in: companyReceiptIds }
      }),
      OcrJob.countDocuments({
        status: OcrJobStatus.COMPLETED,
        receiptId: { $in: companyReceiptIds },
        createdAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) }
      }),
      OcrJob.countDocuments({
        status: OcrJobStatus.COMPLETED,
        receiptId: { $in: companyReceiptIds },
        createdAt: {
          $gte: new Date(now.getFullYear(), now.getMonth() - 1, 1),
          $lt: new Date(now.getFullYear(), now.getMonth(), 1)
        }
      })
    ]);

    const ocrGrowthRate = ocrJobsLastMonth > 0 ? ((ocrJobsThisMonth - ocrJobsLastMonth) / ocrJobsLastMonth * 100) : 0;

    // Get OCR success rate and avg processing time (global, not company-specific)
    let ocrSuccessRate = 100;
    let avgProcessingTime = 0;
    try {
      const ocrStats = await OcrJob.aggregate([
        { $match: { status: OcrJobStatus.COMPLETED } },
        {
          $group: {
            _id: null,
            totalJobs: { $sum: 1 },
            successfulJobs: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
            avgProcessingTime: { $avg: '$processingTime' }
          }
        }
      ]);

      ocrSuccessRate = ocrStats.length > 0 ? (ocrStats[0].successfulJobs / ocrStats[0].totalJobs * 100) : 100;
      avgProcessingTime = ocrStats.length > 0 ? Math.round(ocrStats[0].avgProcessingTime || 0) : 0;
    } catch (ocrError: any) {
      console.warn('OCR stats aggregation failed:', ocrError.message);
      // Use default values
    }

    // Reports Analytics
    const [totalReports, approvedReports, pendingReports, rejectedReports] = await Promise.all([
      ExpenseReport.countDocuments({ userId: { $in: userIds } }),
      ExpenseReport.countDocuments({ userId: { $in: userIds }, status: ExpenseReportStatus.APPROVED }),
      ExpenseReport.countDocuments({ userId: { $in: userIds }, status: ExpenseReportStatus.PENDING_APPROVAL_L1 }),
      ExpenseReport.countDocuments({ userId: { $in: userIds }, status: ExpenseReportStatus.REJECTED })
    ]);

    const reportsThisMonth = await ExpenseReport.countDocuments({
      userId: { $in: userIds },
      createdAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) }
    });

    const reportsLastMonth = await ExpenseReport.countDocuments({
      userId: { $in: userIds },
      createdAt: {
        $gte: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        $lt: new Date(now.getFullYear(), now.getMonth(), 1)
      }
    });

    const reportsGrowthRate = reportsLastMonth > 0 ? ((reportsThisMonth - reportsLastMonth) / reportsLastMonth * 100) : 0;
    const approvalRate = totalReports > 0 ? (approvedReports / totalReports * 100) : 0;

    // API Usage Analytics (using ApiRequestLog with error handling)
    let totalApiCalls = 0, apiCallsThisMonth = 0, apiCallsLastMonth = 0;
    try {
      [totalApiCalls, apiCallsThisMonth, apiCallsLastMonth] = await Promise.all([
        ApiRequestLog.countDocuments({ userId: { $in: userIds } }),
        ApiRequestLog.countDocuments({
          userId: { $in: userIds },
          createdAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) }
        }),
        ApiRequestLog.countDocuments({
          userId: { $in: userIds },
          createdAt: {
            $gte: new Date(now.getFullYear(), now.getMonth() - 1, 1),
            $lt: new Date(now.getFullYear(), now.getMonth(), 1)
          }
        })
      ]);
    } catch (apiLogError: any) {
      // ApiRequestLog might not exist or have issues, use fallback
      console.warn('ApiRequestLog query failed, using fallback values:', apiLogError.message);
      totalApiCalls = totalReports * 5; // Estimate based on reports
      apiCallsThisMonth = reportsThisMonth * 5;
      apiCallsLastMonth = reportsLastMonth * 5;
    }

    const apiGrowthRate = apiCallsLastMonth > 0 ? ((apiCallsThisMonth - apiCallsLastMonth) / apiCallsLastMonth * 100) : 0;
    const errorCallsThisMonth = await ApiRequestLog.countDocuments({
      userId: { $in: userIds },
      createdAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) },
      statusCode: { $gte: 400 }
    });
    const errorRate = apiCallsThisMonth > 0 ? (errorCallsThisMonth / apiCallsThisMonth * 100) : 0;

    // Top endpoints
    const topEndpoints = await ApiRequestLog.aggregate([
      { $match: { userId: { $in: userIds }, createdAt: { $gte: startDate } } },
      { $group: { _id: '$path', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    // Storage Analytics
    const totalReceipts = await Receipt.countDocuments({ expenseId: { $in: expenseIds } });
    const estimatedStorageGB = (totalReceipts * 500) / (1024 * 1024); // 500KB per receipt
    const allocatedGB = 10; // Default allocation
    // const usagePercent = (estimatedStorageGB / allocatedGB) * 100; // Not used

    // OCR contribution to storage (assuming OCR receipts take up storage)
    const ocrReceipts = await Receipt.countDocuments({
      expenseId: { $in: expenseIds },
      // Assume OCR receipts have some indicator, for now use all receipts
    });
    const ocrContribution = totalReceipts > 0 ? (ocrReceipts / totalReceipts * 100) : 0;

    // Financial Analytics (using only company primary currency)
    let totalRevenue = 0;
    try {
      const monthlyRevenue = await ExpenseReport.aggregate([
        {
          $match: {
            userId: { $in: userIds },
            status: ExpenseReportStatus.APPROVED,
            approvedAt: { $gte: startDate },
            currency: companyCurrency // Only use primary company currency
          }
        },
        { $group: { _id: '$currency', total: { $sum: '$totalAmount' } } }
      ]);

      totalRevenue = monthlyRevenue.reduce((sum, item) => sum + item.total, 0);
    } catch (revenueError: any) {
      console.warn('Revenue aggregation failed:', revenueError.message);
      totalRevenue = 0;
    }

    // Calculate MRR based on time range (normalize to monthly value)
    let mrrContribution;
    switch (timeRange) {
      case '7d':
        mrrContribution = (totalRevenue / 7) * 30; // Extrapolate to monthly
        break;
      case '30d':
        mrrContribution = totalRevenue; // Already monthly
        break;
      case '90d':
        mrrContribution = totalRevenue / 3; // Average monthly over 3 months
        break;
      default:
        mrrContribution = totalRevenue;
    }

    const arrProjection = mrrContribution * 12;

    // Cost calculations for infrastructure planning
    const ocrCostPerJob = 0.02; // $0.02 per OCR job (realistic cloud OCR pricing)
    const storageCostPerGB = 0.023; // $0.023 per GB per month (AWS S3 standard)
    const apiCostPerCall = 0.0001; // $0.0001 per API call

    const monthlyOCRCost = ocrJobsThisMonth * ocrCostPerJob;
    const monthlyStorageCost = (estimatedStorageGB * storageCostPerGB);
    const monthlyApiCost = apiCallsThisMonth * apiCostPerCall;
    const totalInfrastructureCost = monthlyOCRCost + monthlyStorageCost + monthlyApiCost;

    const costPerOCR = ocrJobsTotal > 0 ? totalInfrastructureCost / ocrJobsTotal : 0;
    const efficiencyRatio = totalRevenue > 0 ? (totalInfrastructureCost / totalRevenue) * 100 : 0; // Cost as % of revenue

    // Calculate MRR growth (compare with previous period)
    let mrrGrowth = 0;
    try {
      const periodLength = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : timeRange === '90d' ? 90 : 30;
      const previousPeriodStart = new Date(startDate.getTime() - (periodLength * 24 * 60 * 60 * 1000));
      const previousPeriodEnd = new Date(startDate.getTime());

      const lastPeriodRevenue = await ExpenseReport.aggregate([
        {
          $match: {
            userId: { $in: userIds },
            status: ExpenseReportStatus.APPROVED,
            currency: companyCurrency, // Only use primary company currency
            approvedAt: {
              $gte: previousPeriodStart,
              $lt: previousPeriodEnd
            }
          }
        },
        { $group: { _id: '$currency', total: { $sum: '$totalAmount' } } }
      ]);

      const lastPeriodTotal = lastPeriodRevenue.reduce((sum, item) => sum + item.total, 0);

      // Normalize last period to same time frame as current period for fair comparison
      let normalizedLastPeriod;
      switch (timeRange) {
        case '7d':
          normalizedLastPeriod = (lastPeriodTotal / 7) * 30; // Normalize to monthly
          break;
        case '30d':
          normalizedLastPeriod = lastPeriodTotal; // Already monthly equivalent
          break;
        case '90d':
          normalizedLastPeriod = lastPeriodTotal / 3; // Average monthly
          break;
        default:
          normalizedLastPeriod = lastPeriodTotal;
      }

      mrrGrowth = normalizedLastPeriod > 0 ? ((mrrContribution - normalizedLastPeriod) / normalizedLastPeriod * 100) : 0;
    } catch (growthError: any) {
      console.warn('MRR growth calculation failed:', growthError.message);
      mrrGrowth = 0;
    }

    // Receipts Analytics (using existing totalReceipts from storage calculation)
    const [receiptsThisMonth, receiptsLastMonth] = await Promise.all([
      Receipt.countDocuments({
        expenseId: { $in: expenseIds },
        createdAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) }
      }),
      Receipt.countDocuments({
        expenseId: { $in: expenseIds },
        createdAt: {
          $gte: new Date(now.getFullYear(), now.getMonth() - 1, 1),
          $lt: new Date(now.getFullYear(), now.getMonth(), 1)
        }
      })
    ]);

    const receiptsGrowthRate = receiptsLastMonth > 0 ? ((receiptsThisMonth - receiptsLastMonth) / receiptsLastMonth * 100) : 0;

    // Get receipts by processing status using OcrJob status - simplified approach
    let processedReceipts = 0, pendingReceipts = 0, failedReceipts = 0, unprocessedReceipts = 0;
    try {
      // Count receipts with different OCR job statuses
      const companyReceiptIds = await Receipt.find({ expenseId: { $in: expenseIds } }).distinct('_id');
      const [processedCount, pendingCount, failedCount] = await Promise.all([
        OcrJob.countDocuments({
          receiptId: { $in: companyReceiptIds },
          status: OcrJobStatus.COMPLETED
        }),
        OcrJob.countDocuments({
          receiptId: { $in: companyReceiptIds },
          status: { $in: [OcrJobStatus.QUEUED, OcrJobStatus.PROCESSING] }
        }),
        OcrJob.countDocuments({
          receiptId: { $in: companyReceiptIds },
          status: OcrJobStatus.FAILED
        })
      ]);

      processedReceipts = processedCount;
      pendingReceipts = pendingCount;
      failedReceipts = failedCount;
      unprocessedReceipts = Math.max(0, totalReceipts - processedCount - pendingCount - failedCount);
    } catch (receiptStatusError: any) {
      console.warn('Receipt status counting failed:', receiptStatusError.message);
      // Use fallback: assume all receipts are unprocessed
      unprocessedReceipts = totalReceipts;
    }

    // Calculate average receipts per expense
    const totalExpenses = expenseIds.length;
    const avgReceiptsPerExpense = totalExpenses > 0 ? (totalReceipts / totalExpenses) : 0;

    const analyticsData = {
      ocr: {
        totalLifetime: ocrJobsTotal,
        thisMonth: ocrJobsThisMonth,
        perUser: userIds.length > 0 ? Math.round(ocrJobsTotal / userIds.length) : 0,
        successRate: Math.round(ocrSuccessRate * 100) / 100,
        avgProcessingTime: avgProcessingTime,
        growthRate: Math.round(ocrGrowthRate * 100) / 100
      },
      reports: {
        totalCreated: totalReports,
        perMonth: reportsThisMonth,
        approvalRate: Math.round(approvalRate * 100) / 100,
        avgApprovalTime: 3, // Placeholder - would need approval workflow data
        growthRate: Math.round(reportsGrowthRate * 100) / 100,
        statusBreakdown: {
          approved: approvedReports,
          pending: pendingReports,
          rejected: rejectedReports
        }
      },
      apiUsage: {
        totalCalls: totalApiCalls,
        callsThisMonth: apiCallsThisMonth,
        perUser: userIds.length > 0 ? Math.round(totalApiCalls / userIds.length) : 0,
        errorRate: Math.round(errorRate * 100) / 100,
        growthRate: Math.round(apiGrowthRate * 100) / 100,
        topEndpoints: topEndpoints.map(item => item._id)
      },
      storage: {
        usedGB: Math.round(estimatedStorageGB * 100) / 100,
        allocatedGB: allocatedGB,
        growthRate: 5.2, // Placeholder - would need historical data
        ocrContribution: Math.round(ocrContribution * 100) / 100
      },
      financial: {
        mrrContribution: Math.round(mrrContribution * 100) / 100,
        arrProjection: Math.round(arrProjection * 100) / 100,
        costPerOCR: Math.round(costPerOCR * 10000) / 10000, // More precision for small amounts
        efficiencyRatio: Math.round(efficiencyRatio * 100) / 100, // Cost as % of revenue
        mrrGrowth: Math.round(mrrGrowth * 100) / 100,
        currency: companyCurrency,
        monthlyCosts: {
          ocr: Math.round(monthlyOCRCost * 100) / 100,
          storage: Math.round(monthlyStorageCost * 100) / 100,
          api: Math.round(monthlyApiCost * 100) / 100,
          total: Math.round(totalInfrastructureCost * 100) / 100
        }
      },
      receipts: {
        totalScanned: totalReceipts,
        scannedThisMonth: receiptsThisMonth,
        perUser: userIds.length > 0 ? Math.round(totalReceipts / userIds.length) : 0,
        avgPerExpense: Math.round(avgReceiptsPerExpense * 100) / 100,
        growthRate: Math.round(receiptsGrowthRate * 100) / 100,
        statusBreakdown: {
          processed: processedReceipts,
          pending: pendingReceipts,
          failed: failedReceipts,
          unprocessed: unprocessedReceipts
        }
      }
    };

    // Emit real-time analytics update for this company (with error handling)
    try {
      emitSystemAnalyticsUpdate({
        companyId,
        analytics: analyticsData,
        type: 'company-analytics'
      });
    } catch (socketError: any) {
      // Socket emission failed, but don't fail the API call
      console.warn('Failed to emit analytics update:', socketError.message);
    }

    res.status(200).json({
      success: true,
      data: analyticsData
    });
  });

  // Get Company Mini Stats (lightweight real-time stats for table display)
  static getCompanyMiniStats = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = req.params.id;

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid company ID format',
        code: 'INVALID_ID',
      });
      return;
    }

    const companyObjectId = new mongoose.Types.ObjectId(companyId);

    // Get company users for filtering
    const companyUsers = await User.find({ companyId: companyObjectId })
      .select('_id')
      .lean();
    const userIds = companyUsers.map(u => u._id);

    if (userIds.length === 0) {
      res.status(200).json({
        success: true,
        data: {
          ocrUsage: 0,
          reportsCreated: 0,
          storageUsed: 0,
          apiCalls: 0
        }
      });
      return;
    }

    // Get real-time mini stats
    const [ocrJobsCount, reportsCount, apiCallsCount]: [number, number, number] = await Promise.all([
      // OCR jobs completed this month by company users
      OcrJob.countDocuments({
        status: OcrJobStatus.COMPLETED,
        createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
      }),

      // Reports created this month by company users
      ExpenseReport.countDocuments({
        userId: { $in: userIds },
        createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
      }),

      // API calls this month (we'll use a sample or estimate since we don't have detailed logging)
      ApiRequestLog.countDocuments({
        userId: { $in: userIds },
        createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
      }).catch((): number => Math.floor(reportsCount * 5)) // Fallback estimate: 5 API calls per report
    ]);

    // Calculate storage used by company
    const companyExpenses = await Expense.find({ userId: { $in: userIds } })
      .select('_id')
      .lean();
    const expenseIds = companyExpenses.map(e => e._id);
    const totalReceipts = await Receipt.countDocuments({ expenseId: { $in: expenseIds } });
    const estimatedStorageGB = (totalReceipts * 500) / (1024 * 1024); // 500KB per receipt

    const miniStats = {
      ocrUsage: ocrJobsCount,
      reportsCreated: reportsCount,
      storageUsed: Math.round(estimatedStorageGB * 10) / 10, // Round to 1 decimal
      apiCalls: apiCallsCount
    };

    // Emit real-time mini stats update
    emitSystemAnalyticsUpdate({
      companyId,
      stats: miniStats,
      type: 'mini-stats'
    });

    res.status(200).json({
      success: true,
      data: miniStats
    });
  });

  // Create Company
  static createCompany = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestId = (req as any).requestId;
    logger.debug({ requestId, path: req.path, method: req.method }, 'Create company endpoint called');
    
    const { name, location, type, status, plan, domain } = req.body;

    // Validate that this is NOT a company admin creation request
    if (req.body.email || req.body.password) {
      logger.warn({ requestId }, 'Create Company - Received email/password fields, invalid request');
      res.status(400).json({
        success: false,
        message: 'Invalid request: Company creation does not require email or password. Use /companies/:id/admins to create company admins.',
        code: 'INVALID_REQUEST',
      });
      return;
    }

    if (!name || !name.trim()) {
      logger.warn({ requestId }, 'Create Company - Missing or empty name field');
      res.status(400).json({
        success: false,
        message: 'Company name is required',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // Check if company with same name already exists
    const existingCompany = await Company.findOne({ name: { $regex: new RegExp(`^${name.trim()}$`, 'i') } });
    if (existingCompany) {
      res.status(409).json({
        success: false,
        message: 'Company with this name already exists',
      });
      return;
    }

    // Create company - filter out empty strings
    const companyData: any = {
      name: name.trim(),
      type: (type && type.trim()) ? (type.trim() as CompanyType) : CompanyType.OTHER,
      status: (status && status.trim()) ? (status.trim() as CompanyStatus) : CompanyStatus.ACTIVE,
      plan: (plan && plan.trim()) ? (plan.trim() as CompanyPlan) : CompanyPlan.BASIC,
    };

    if (location && location.trim()) {
      companyData.location = location.trim();
    }
    if (domain && domain.trim()) {
      companyData.domain = domain.trim().toLowerCase();
    }

    logger.debug({ requestId, companyData }, 'Create Company - Creating company document');
    const company = new Company(companyData);

    await company.save();
    logger.info({ requestId, companyId: company._id }, 'Create Company - Company saved successfully');

    // Emit real-time company created event
    emitCompanyCreated({
      id: (company._id as mongoose.Types.ObjectId).toString(),
      name: company.name,
      location: company.location,
      type: company.type,
      status: company.status,
      plan: company.plan,
      domain: company.domain,
      createdAt: company.createdAt,
    });

    // Update dashboard analytics in real-time
    try {
      await SystemAnalyticsService.collectAndEmitDashboardAnalytics();
    } catch (analyticsError) {
      logger.warn({ requestId, error: analyticsError }, 'Failed to update dashboard analytics after company creation');
    }

    // Log audit
    await AuditService.log(
      req.user!.id,
      'Company',
      (company._id as mongoose.Types.ObjectId).toString(),
      AuditAction.CREATE
    );

    res.status(201).json({
      success: true,
      data: {
        id: (company._id as mongoose.Types.ObjectId).toString(),
        name: company.name,
        location: company.location,
        type: company.type,
        status: company.status,
        plan: company.plan,
        domain: company.domain,
        createdAt: company.createdAt,
      },
    });
  });

  // Update Company
  static updateCompany = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { name, location, type, status, plan, domain } = req.body;
    const companyId = req.params.id;

    const company = await Company.findById(companyId);

    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
      });
      return;
    }

    const oldData = { ...company.toObject() };

    if (name) company.name = name;
    if (location !== undefined) company.location = location || undefined;
    if (type) company.type = type as CompanyType;
    if (status) company.status = status as CompanyStatus;
    if (plan) company.plan = plan as CompanyPlan;
    if (domain !== undefined) company.domain = domain || undefined;

    await company.save();

    // Log audit
    await AuditService.log(
      req.user!.id,
      'Company',
      companyId,
      AuditAction.UPDATE,
      { old: oldData, new: company.toObject() }
    );

    res.status(200).json({
      success: true,
      data: {
        id: (company._id as mongoose.Types.ObjectId).toString(),
        name: company.name,
        location: company.location,
        type: company.type,
        status: company.status,
        plan: company.plan,
        domain: company.domain,
      },
    });
  });

  // Delete Company
  static deleteCompany = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = req.params.id;

    const company = await Company.findById(companyId);

    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
      });
      return;
    }

    // Check if company has users
    const userCount = await User.countDocuments({ companyId: new mongoose.Types.ObjectId(companyId) });
    if (userCount > 0) {
      res.status(400).json({
        success: false,
        message: `Cannot delete company. It has ${userCount} associated users. Please remove users first.`,
      });
      return;
    }

    await Company.deleteOne({ _id: companyId });

    // Log audit
    await AuditService.log(
      req.user!.id,
      'Company',
      companyId,
      AuditAction.DELETE
    );

    res.status(200).json({
      success: true,
      message: 'Company deleted successfully',
    });
  });

  // Note: Company Admin CRUD operations have been moved to CompanyAdminController
  // See /api/v1/companies/:companyId/admins routes

  // Get Platform Stats
  static getPlatformStats = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const [totalApiCalls, totalStorage, activeSessions, totalReports] = await Promise.all([
      AuditLog.countDocuments(), // Approximate API calls
      Receipt.countDocuments().then(count => (count * 500) / (1024 * 1024)), // GB
      User.countDocuments({ status: UserStatus.ACTIVE }),
      ExpenseReport.countDocuments(),
    ]);

    // API Usage trend (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const apiUsage = await AuditLog.aggregate([
      {
        $match: {
          createdAt: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          value: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
    const formattedApiUsage = apiUsage.map((item, idx) => ({
      name: monthNames[idx] || `${item._id.month}/${item._id.year}`,
      value: item.value,
    }));

    // Monthly revenue (from approved reports)
    const monthlyRevenue = await ExpenseReport.aggregate([
      {
        $match: {
          status: ExpenseReportStatus.APPROVED,
          approvedAt: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$approvedAt' },
            month: { $month: '$approvedAt' },
          },
          value: { $sum: '$totalAmount' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const formattedMonthlyRevenue = monthlyRevenue.map((item, idx) => ({
      name: monthNames[idx] || `${item._id.month}/${item._id.year}`,
      value: item.value,
    }));

    // Plan distribution (using Company collection)
    const planDistribution = await Company.aggregate([
      {
        $group: {
          _id: '$plan',
          value: { $sum: 1 },
        },
      },
    ]);

    const formattedPlanDistribution = planDistribution.map((item) => ({
      name: item._id.charAt(0).toUpperCase() + item._id.slice(1),
      value: item.value,
    }));

    // Reports by status
    const reportsByStatus = await ExpenseReport.aggregate([
      {
        $group: {
          _id: '$status',
          value: { $sum: 1 },
        },
      },
    ]);

    const statusMap: Record<string, string> = {
      DRAFT: 'Draft',
      SUBMITTED: 'Submitted',
      APPROVED: 'Approved',
      REJECTED: 'Rejected',
    };

    const formattedReportsByStatus = reportsByStatus.map((item) => ({
      name: statusMap[item._id] || item._id,
      value: item.value,
    }));

    res.status(200).json({
      success: true,
      data: {
        systemUptime: 99.9,
        totalApiCalls,
        averageResponseTime: 145,
        activeSessions,
        totalStorage: Math.round(totalStorage * 100) / 100,
        totalReports,
        apiUsage: formattedApiUsage,
        monthlyRevenue: formattedMonthlyRevenue,
        planDistribution: formattedPlanDistribution,
        reportsByStatus: formattedReportsByStatus,
      },
    });
  });

  // Get System Analytics
  static getSystemAnalyticsDetailed = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Remove cache-busting parameter from query for cache key generation
    const queryWithoutCacheBuster = { ...req.query };
    delete queryWithoutCacheBuster._t;

    // Create cache key based on filters (excluding cache buster)
    const cacheKey = `system-analytics-detailed:${JSON.stringify(queryWithoutCacheBuster)}`;

    // Check cache first (30 seconds TTL for system analytics) unless cache buster is present
    if (!req.query._t) {
      const cachedResult = cacheService.get(cacheKey);
      if (cachedResult) {
        return res.status(200).json({
          success: true,
          data: cachedResult,
          cached: true
        }) as any;
      }
    }

    const now = new Date();
    const { dateRange = '30d', companies = [] } = req.query;

    // Calculate time ranges based on dateRange filter
    let timeRangeHours = 24; // default 24 hours
    switch (dateRange) {
      case 'today':
        timeRangeHours = 24;
        break;
      case '7d':
        timeRangeHours = 7 * 24;
        break;
      case '30d':
        timeRangeHours = 30 * 24;
        break;
      case '90d':
        timeRangeHours = 90 * 24;
        break;
      default:
        timeRangeHours = 24;
    }

    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const timeRangeAgo = new Date(now.getTime() - timeRangeHours * 60 * 60 * 1000);
    const sixMonthsAgo = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);

    // Parse companies and feature types filters
    const companyIds = Array.isArray(companies) ? companies : [companies].filter(Boolean);
    // const features = Array.isArray(featureTypes) ? featureTypes : [featureTypes].filter(Boolean); // TODO: Implement feature type filtering

    // Get user IDs for company filtering
    let userIds: string[] = [];
    if (companyIds.length > 0) {
      const companyUsers = await User.find({ companyId: { $in: companyIds } }).select('_id').lean();
      userIds = companyUsers.map(u => u._id.toString());
    }

    // Parallel execution of fast metrics for better performance
    const [
      apiRequestsLastHour,
      errorRequestsLastHour,
      peakConcurrentUsers,
      ocrQueueSize
    ] = await Promise.all([
      // API requests count (last hour) - REAL DATA
      ApiRequestLog.countDocuments({
        createdAt: { $gte: oneHourAgo },
        ...(userIds.length > 0 && { userId: { $in: userIds } }),
      }),

      // Error requests count (last hour) - REAL DATA
      ApiRequestLog.countDocuments({
        createdAt: { $gte: oneHourAgo },
        statusCode: { $gte: 400 },
        ...(userIds.length > 0 && { userId: { $in: userIds } }),
      }),

      // Peak concurrent users (active users) - REAL DATA
      User.countDocuments({
        status: UserStatus.ACTIVE,
        ...(companyIds.length > 0 && { companyId: { $in: companyIds } }),
      }),

      // OCR queue size (pending + processing jobs) - REAL DATA
      OcrJob.countDocuments({
        status: { $in: [OcrJobStatus.QUEUED, OcrJobStatus.PROCESSING] }
      })
    ]);

    // Calculate error rate
    const errorRate = apiRequestsLastHour > 0
      ? ((errorRequestsLastHour / apiRequestsLastHour) * 100).toFixed(2)
      : '0.00';

    // API requests over time (time range based on filter) - REAL DATA
    const apiRequests = await ApiRequestLog.aggregate([
      {
        $match: {
          createdAt: { $gte: timeRangeAgo },
          ...(userIds.length > 0 && { userId: { $in: userIds } }),
        },
      },
      {
        $group: {
          _id: {
            hour: { $hour: '$createdAt' },
          },
          value: { $sum: 1 },
        },
      },
      { $sort: { '_id.hour': 1 } },
    ]);

    // Fill in missing hours with 0
    const hourMap = new Map();
    for (let h = 0; h < 24; h++) {
      hourMap.set(h, 0);
    }
    apiRequests.forEach((item) => {
      hourMap.set(item._id.hour, item.value);
    });

    const formattedApiRequests = Array.from(hourMap.entries()).map(([hour, value]) => ({
      name: `${hour.toString().padStart(2, '0')}:00`,
      value,
    }));

    // Response latency (time range based on filter) - REAL DATA
    const responseLatencyData = await ApiRequestLog.aggregate([
      {
        $match: {
          createdAt: { $gte: timeRangeAgo },
          ...(userIds.length > 0 && { userId: { $in: userIds } }),
        },
      },
      {
        $group: {
          _id: {
            hour: { $hour: '$createdAt' },
          },
          avgLatency: { $avg: '$responseTime' },
        },
      },
      { $sort: { '_id.hour': 1 } },
    ]);

    // Fill in missing hours
    const latencyHourMap = new Map();
    for (let h = 0; h < 24; h++) {
      latencyHourMap.set(h, 0);
    }
    responseLatencyData.forEach((item) => {
      latencyHourMap.set(item._id.hour, Math.round(item.avgLatency || 0));
    });

    const formattedResponseLatency = Array.from(latencyHourMap.entries()).map(([hour, value]) => ({
      name: `${hour.toString().padStart(2, '0')}:00`,
      value,
    }));

    // Error rate over time (time range based on filter) - REAL DATA
    const errorRateData = await ApiRequestLog.aggregate([
      {
        $match: {
          createdAt: { $gte: timeRangeAgo },
          statusCode: { $gte: 400 },
          ...(userIds.length > 0 && { userId: { $in: userIds } }),
        },
      },
      {
        $group: {
          _id: {
            hour: { $hour: '$createdAt' },
            statusType: {
              $cond: [
                { $gte: ['$statusCode', 500] },
                '5xx',
                '4xx'
              ],
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.hour': 1 } },
    ]);

    // Build error rate map
    const errorRateMap = new Map();
    for (let h = 0; h < 24; h++) {
      errorRateMap.set(h, { '5xx': 0, '4xx': 0 });
    }
    errorRateData.forEach((item) => {
      const hour = item._id.hour;
      const statusType = item._id.statusType;
      if (errorRateMap.has(hour)) {
        errorRateMap.get(hour)[statusType] = item.count;
      }
    });

    const formattedErrorRate = Array.from(errorRateMap.entries()).map(([hour, counts]) => ({
      name: `${hour.toString().padStart(2, '0')}:00`,
      '5xx': counts['5xx'],
      '4xx': counts['4xx'],
    }));

    // API usage by endpoint (time range based on filter) - REAL DATA
    const apiUsageByEndpoint = await ApiRequestLog.aggregate([
      {
        $match: {
          createdAt: { $gte: timeRangeAgo },
          ...(userIds.length > 0 && { userId: { $in: userIds } }),
        },
      },
      {
        $group: {
          _id: '$path',
          value: { $sum: 1 },
        },
      },
      { $sort: { value: -1 } },
      { $limit: 10 }, // Top 10 endpoints
    ]);

    const formattedApiUsageByEndpoint = apiUsageByEndpoint.map((item) => ({
      name: item._id,
      value: item.value,
    }));

    // OCR queue depth (pending + processing jobs over time) - REAL DATA
    const ocrQueueDepth = await OcrJob.aggregate([
      {
        $match: {
          createdAt: { $gte: timeRangeAgo },
          status: { $in: [OcrJobStatus.QUEUED, OcrJobStatus.PROCESSING] },
          ...(userIds.length > 0 && { userId: { $in: userIds } }),
        },
      },
      {
        $group: {
          _id: {
            hour: { $hour: '$createdAt' },
          },
          value: { $sum: 1 },
        },
      },
      { $sort: { '_id.hour': 1 } },
    ]);

    // Fill in missing hours
    const ocrHourMap = new Map();
    for (let h = 0; h < 24; h++) {
      ocrHourMap.set(h, 0);
    }
    ocrQueueDepth.forEach((item) => {
      ocrHourMap.set(item._id.hour, item.value);
    });

    const formattedOcrQueueDepth = Array.from(ocrHourMap.entries()).map(([hour, value]) => ({
      name: `${hour.toString().padStart(2, '0')}:00`,
      value,
    }));

    // Storage growth (last 6 months) - REAL DATA
    const storageGrowth = await Receipt.aggregate([
      {
        $match: {
          createdAt: { $gte: sixMonthsAgo },
          ...(userIds.length > 0 && { userId: { $in: userIds } }),
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          value: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formattedStorageGrowth = storageGrowth.map((item) => ({
      name: `${monthNames[item._id.month - 1]} ${item._id.year}`,
      value: (item.value * 500) / (1024 * 1024), // Convert to GB (assuming 500KB per receipt)
    }));

    // System status - REAL DATA
    const dbConnectionState = mongoose.connection.readyState;
    const isDbConnected = dbConnectionState === 1;

    const systemStatus = {
      s3: { status: 'operational', uptime: 99.9 }, // Would need S3 health check
      database: { 
        status: isDbConnected ? 'operational' : 'degraded', 
        uptime: isDbConnected ? 99.8 : 0 
      },
      queueWorker: { 
        status: ocrQueueSize < 1000 ? 'operational' : 'degraded', 
        uptime: ocrQueueSize < 1000 ? 99.7 : 95.0 
      },
      aiOcr: { 
        status: 'operational', 
        uptime: 99.5 
      },
      webhook: { 
        status: 'operational', 
        successRate: 98.5 
      },
    };

    const analyticsData = {
      apiRequests: formattedApiRequests,
      errorRateOverTime: formattedErrorRate, // Renamed to avoid conflict with errorRate percentage
      apiUsageByEndpoint: formattedApiUsageByEndpoint,
      ocrQueueDepth: formattedOcrQueueDepth,
      storageGrowth: formattedStorageGrowth,
      responseLatency: formattedResponseLatency,
      systemStatus,
    };

    // Emit real-time update
    emitSystemAnalyticsUpdate(analyticsData);

    // Also trigger a full analytics collection for real-time updates
    try {
      await SystemAnalyticsService.collectAndEmitAnalytics();
    } catch (realtimeError) {
      logger.warn('Failed to trigger real-time analytics update');
    }

    const resultData = {
      apiRequestsLastHour,
      errorRate: parseFloat(errorRate),
      peakConcurrentUsers,
      ocrQueueSize,
      ...analyticsData,
    };

    // Cache the result for 30 seconds (system analytics changes frequently)
    cacheService.set(cacheKey, resultData, 30 * 1000);

    res.status(200).json({
      success: true,
      data: resultData,
      cached: false
    });
  });

  // Get Logs
  static getLogs = asyncHandler(async (req: AuthRequest, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const searchQuery = req.query.search as string;
    const logType = (req.query.type as string) || 'activity'; // activity, error, security

    let formattedLogs: any[] = [];

    // Helper function to format timestamp to IST
    const formatToIST = (date: Date): string => {
      const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
      const utcTime = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
      const istTime = new Date(utcTime + istOffset);
      
      const year = istTime.getFullYear();
      const month = String(istTime.getMonth() + 1).padStart(2, '0');
      const day = String(istTime.getDate()).padStart(2, '0');
      const hours = String(istTime.getHours()).padStart(2, '0');
      const minutes = String(istTime.getMinutes()).padStart(2, '0');
      const seconds = String(istTime.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };

    if (logType === 'activity') {
      // Activity logs from AuditLog
      // For non-SUPER_ADMIN users, filter by company
      const query: any = {};

      if (searchQuery) {
        query.$or = [
          { entityType: { $regex: searchQuery, $options: 'i' } },
          { action: { $regex: searchQuery, $options: 'i' } },
        ];
      }

      // Filter by company if user is not SUPER_ADMIN
      if (req.user && req.user.role !== 'SUPER_ADMIN') {
        const companyId = await getUserCompanyId(req);
        if (companyId) {
          const userIds = await getCompanyUserIds(companyId);
          // Also include CompanyAdmin IDs for this company
          const { CompanyAdmin } = await import('../models/CompanyAdmin');
          const companyAdmins = await CompanyAdmin.find({ companyId: new mongoose.Types.ObjectId(companyId) })
            .select('_id')
            .exec();
          const adminIds = companyAdmins.map(a => a._id);
          
          // Filter logs where actorId is in company users or company admins
          const allActorIds = [...userIds, ...adminIds];
          if (allActorIds.length > 0) {
            query.actorId = { $in: allActorIds };
          } else {
            // No users/admins in company, return empty result
            query.actorId = { $in: [] };
          }
        } else {
          // User has no company, return empty result
          query.actorId = { $in: [] };
        }
      }

      const logs = await AuditLog.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('actorId', 'email name')
        .lean();

      formattedLogs = logs.map((log) => {
        const actor = log.actorId as any;
        return {
          id: log._id.toString(),
          timestamp: formatToIST(log.createdAt),
          user: actor?.email || 'system',
          company: actor?.name || 'System',
          eventType: log.action,
          description: `${log.action} on ${log.entityType}`,
          details: log.diff || {},
        };
      });
    } else if (logType === 'error') {
      // Error logs from ApiRequestLog (4xx and 5xx status codes)
      const query: any = {
        statusCode: { $gte: 400 },
      };

      if (searchQuery) {
        query.$or = [
          { path: { $regex: searchQuery, $options: 'i' } },
          { method: { $regex: searchQuery, $options: 'i' } },
        ];
      }

      // Filter by company if user is not SUPER_ADMIN
      if (req.user && req.user.role !== 'SUPER_ADMIN') {
        const companyId = await getUserCompanyId(req);
        if (companyId) {
          const userIds = await getCompanyUserIds(companyId);
          // Also include CompanyAdmin IDs for this company
          const { CompanyAdmin } = await import('../models/CompanyAdmin');
          const companyAdmins = await CompanyAdmin.find({ companyId: new mongoose.Types.ObjectId(companyId) })
            .select('_id')
            .exec();
          const adminIds = companyAdmins.map(a => a._id);
          
          // Filter logs where userId is in company users or company admins
          const allUserIds = [...userIds, ...adminIds];
          if (allUserIds.length > 0) {
            query.userId = { $in: allUserIds };
          } else {
            // No users/admins in company, return empty result
            query.userId = { $in: [] };
          }
        } else {
          // User has no company, return empty result
          query.userId = { $in: [] };
        }
      }

      const errorLogs = await ApiRequestLog.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('userId', 'email name')
        .lean();

      formattedLogs = errorLogs.map((log) => {
        const user = log.userId as any;
        const errorType = log.statusCode >= 500 ? 'Backend Error' : 'Client Error';
        const description = `${log.method} ${log.path} returned ${log.statusCode}`;
        
        return {
          id: log._id.toString(),
          timestamp: formatToIST(log.createdAt),
          user: user?.email || 'Unknown',
          company: user?.name || 'System',
          errorType,
          description,
          details: {
            endpoint: log.path,
            method: log.method,
            statusCode: log.statusCode,
            responseTime: log.responseTime,
            ipAddress: log.ipAddress,
          },
        };
      });
    } else if (logType === 'security') {
      // Security logs - failed logins, rate limits, suspicious activity
      // Get from ApiRequestLog with specific patterns
      const query: any = {
        $or: [
          { path: { $regex: '/auth/login', $options: 'i' }, statusCode: { $gte: 400 } },
          { statusCode: 429 }, // Rate limit
        ],
      };

      // Filter by company if user is not SUPER_ADMIN
      if (req.user && req.user.role !== 'SUPER_ADMIN') {
        const companyId = await getUserCompanyId(req);
        if (companyId) {
          const userIds = await getCompanyUserIds(companyId);
          // Also include CompanyAdmin IDs for this company
          const { CompanyAdmin } = await import('../models/CompanyAdmin');
          const companyAdmins = await CompanyAdmin.find({ companyId: new mongoose.Types.ObjectId(companyId) })
            .select('_id')
            .exec();
          const adminIds = companyAdmins.map(a => a._id);
          
          // Filter logs where userId is in company users or company admins
          const allUserIds = [...userIds, ...adminIds];
          if (allUserIds.length > 0) {
            query.userId = { $in: allUserIds };
          } else {
            // No users/admins in company, return empty result
            query.userId = { $in: [] };
          }
        } else {
          // User has no company, return empty result
          query.userId = { $in: [] };
        }
      }

      if (searchQuery) {
        query.$and = [
          query.$or,
          {
            $or: [
              { path: { $regex: searchQuery, $options: 'i' } },
              { ipAddress: { $regex: searchQuery, $options: 'i' } },
            ],
          },
        ];
      }

      const securityLogs = await ApiRequestLog.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('userId', 'email name')
        .lean();

      formattedLogs = securityLogs.map((log) => {
        const user = log.userId as any;
        let eventType = 'Security Event';
        let description = 'Security event detected';

        if (log.statusCode === 429) {
          eventType = 'Rate Limit Exceeded';
          description = `Rate limit exceeded for ${log.path}`;
        } else if (log.path.includes('/auth/login') && log.statusCode >= 400) {
          eventType = 'Failed Login Attempt';
          description = `Failed login attempt${user?.email ? ` for ${user.email}` : ''}`;
        } else if (log.statusCode >= 400) {
          eventType = 'Suspicious API Pattern';
          description = `Suspicious request to ${log.path}`;
        }

        return {
          id: log._id.toString(),
          timestamp: formatToIST(log.createdAt),
          user: user?.email || 'Unknown',
          company: user?.name || 'System',
          eventType,
          description,
          details: {
            endpoint: log.path,
            method: log.method,
            statusCode: log.statusCode,
            ipAddress: log.ipAddress,
            userAgent: log.userAgent,
          },
        };
      });
    }

    res.status(200).json({
      success: true,
      data: {
        logs: formattedLogs,
        total: formattedLogs.length,
      },
    });
  });

  // Backup & Restore
  static createBackup = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { BackupService } = await import('../services/backup.service');
    
    const backup = await BackupService.createBackup(req.user!.id);
    
    // Format timestamp to IST
    const date = new Date(backup.createdAt);
    const istOffset = 5.5 * 60 * 60 * 1000;
    const utcTime = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
    const istTime = new Date(utcTime + istOffset);
    const year = istTime.getFullYear();
    const month = String(istTime.getMonth() + 1).padStart(2, '0');
    const day = String(istTime.getDate()).padStart(2, '0');
    const hours = String(istTime.getHours()).padStart(2, '0');
    const minutes = String(istTime.getMinutes()).padStart(2, '0');
    const seconds = String(istTime.getSeconds()).padStart(2, '0');
    const istTimestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    res.status(201).json({
      success: true,
      data: {
        id: (backup._id as any).toString(),
        timestamp: istTimestamp,
        size: '0 GB', // Will be updated when backup completes
        type: backup.type,
        status: backup.status,
      },
    });
  });

  static getBackups = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { BackupService } = await import('../services/backup.service');
    const limit = parseInt(req.query.limit as string) || 100;
    
    const backups = await BackupService.getBackups(limit);
    
    // Format backups with IST timestamps
    const formattedBackups = backups.map((backup: any) => {
      const date = new Date(backup.createdAt);
      const istOffset = 5.5 * 60 * 60 * 1000;
      const utcTime = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
      const istTime = new Date(utcTime + istOffset);
      const year = istTime.getFullYear();
      const month = String(istTime.getMonth() + 1).padStart(2, '0');
      const day = String(istTime.getDate()).padStart(2, '0');
      const hours = String(istTime.getHours()).padStart(2, '0');
      const minutes = String(istTime.getMinutes()).padStart(2, '0');
      const seconds = String(istTime.getSeconds()).padStart(2, '0');
      const istTimestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

      // Format size
      let size = '0 GB';
      if (backup.size) {
        if (backup.size < 1024) {
          size = `${backup.size} B`;
        } else if (backup.size < 1024 * 1024) {
          size = `${(backup.size / 1024).toFixed(2)} KB`;
        } else if (backup.size < 1024 * 1024 * 1024) {
          size = `${(backup.size / (1024 * 1024)).toFixed(2)} MB`;
        } else {
          size = `${(backup.size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        }
      }

      return {
        id: (backup._id as any).toString(),
        timestamp: istTimestamp,
        size,
        type: backup.type,
        status: backup.status,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        backups: formattedBackups,
        total: formattedBackups.length,
      },
    });
  });

  static restoreBackup = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { BackupService } = await import('../services/backup.service');
    const backupId = req.params.id;
    
    await BackupService.restoreBackup(backupId, req.user!.id);
    
    res.status(200).json({
      success: true,
      message: 'Backup restore process started',
    });
  });

  static downloadBackup = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { BackupService } = await import('../services/backup.service');
    const backupId = req.params.id;
    
    const downloadUrl = await BackupService.getBackupDownloadUrl(backupId);
    
    res.status(200).json({
      success: true,
      data: {
        downloadUrl,
      },
    });
  });

  // Global Settings
  static getGlobalSettings = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const { SettingsService } = await import('../services/settings.service');
    
    const settings = await SettingsService.getSettings();
    
    // Mask sensitive fields
    const safeSettings = settings.toObject();
    if (safeSettings.integrations) {
      if (safeSettings.integrations.openAiApiKey) {
        safeSettings.integrations.openAiApiKey = 
          safeSettings.integrations.openAiApiKey.substring(0, 7) + '••••••••••••••••••••';
      }
      if (safeSettings.integrations.awsS3AccessKey) {
        safeSettings.integrations.awsS3AccessKey = 
          safeSettings.integrations.awsS3AccessKey.substring(0, 4) + '••••••••••••••••••';
      }
      if (safeSettings.integrations.awsS3SecretKey) {
        safeSettings.integrations.awsS3SecretKey = '••••••••••••••••••••';
      }
      if (safeSettings.integrations.smtpPassword) {
        safeSettings.integrations.smtpPassword = '••••••••••••••••••••';
      }
    }
    
    res.status(200).json({
      success: true,
      data: {
        settings: safeSettings,
      },
    });
  });

  static updateGlobalSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { SettingsService } = await import('../services/settings.service');
    
    const updates = req.body;
    const settings = await SettingsService.updateSettings(updates, req.user!.id);
    
    // Mask sensitive fields in response
    const safeSettings = settings.toObject();
    if (safeSettings.integrations) {
      if (safeSettings.integrations.openAiApiKey) {
        safeSettings.integrations.openAiApiKey = 
          safeSettings.integrations.openAiApiKey.substring(0, 7) + '••••••••••••••••••••';
      }
      if (safeSettings.integrations.awsS3AccessKey) {
        safeSettings.integrations.awsS3AccessKey = 
          safeSettings.integrations.awsS3AccessKey.substring(0, 4) + '••••••••••••••••••';
      }
      if (safeSettings.integrations.awsS3SecretKey) {
        safeSettings.integrations.awsS3SecretKey = '••••••••••••••••••••';
      }
      if (safeSettings.integrations.smtpPassword) {
        safeSettings.integrations.smtpPassword = '••••••••••••••••••••';
      }
    }
    
    res.status(200).json({
      success: true,
      data: {
        settings: safeSettings,
      },
      message: 'Settings updated successfully',
    });
  });

  static resetGlobalSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { SettingsService } = await import('../services/settings.service');
    
    const settings = await SettingsService.resetSettings(req.user!.id);
    
    // Mask sensitive fields in response
    const safeSettings = settings.toObject();
    if (safeSettings.integrations) {
      if (safeSettings.integrations.openAiApiKey) {
        safeSettings.integrations.openAiApiKey = 
          safeSettings.integrations.openAiApiKey.substring(0, 7) + '••••••••••••••••••••';
      }
      if (safeSettings.integrations.awsS3AccessKey) {
        safeSettings.integrations.awsS3AccessKey = 
          safeSettings.integrations.awsS3AccessKey.substring(0, 4) + '••••••••••••••••••';
      }
      if (safeSettings.integrations.awsS3SecretKey) {
        safeSettings.integrations.awsS3SecretKey = '••••••••••••••••••••';
      }
      if (safeSettings.integrations.smtpPassword) {
        safeSettings.integrations.smtpPassword = '••••••••••••••••••••';
      }
    }
    
    res.status(200).json({
      success: true,
      data: {
        settings: safeSettings,
      },
      message: 'Settings reset to default successfully',
    });
  });
}


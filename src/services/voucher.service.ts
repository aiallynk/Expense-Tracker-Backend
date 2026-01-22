import mongoose from 'mongoose';

import { AdvanceCash, AdvanceCashStatus, IAdvanceCash } from '../models/AdvanceCash';
import { VoucherUsage, VoucherUsageStatus, IVoucherUsage } from '../models/VoucherUsage';
import { ExpenseReport } from '../models/ExpenseReport';
import { ExpenseReportStatus } from '../utils/enums';
import { User } from '../models/User';
import { AuditService } from './audit.service';
import { AuditAction } from '../utils/enums';
import { LedgerService } from './ledger.service';
import { LedgerEntryType } from '../models/Ledger';

import { logger } from '@/config/logger';

export class VoucherService {
  /**
   * Create a new voucher (Admin only)
   */
  static async createVoucher(params: {
    companyId: string;
    employeeId: string;
    totalAmount: number;
    currency?: string;
    projectId?: string;
    costCentreId?: string;
    voucherCode?: string;
    createdBy: string;
  }): Promise<IAdvanceCash> {
    const companyObjectId = new mongoose.Types.ObjectId(params.companyId);
    const employeeObjectId = new mongoose.Types.ObjectId(params.employeeId);

    const totalAmount = Number(params.totalAmount);
    if (!isFinite(totalAmount) || totalAmount <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    const currency = (params.currency || 'INR').toUpperCase();

    // Check if voucher code already exists
    if (params.voucherCode) {
      const existing = await AdvanceCash.findOne({ voucherCode: params.voucherCode }).exec();
      if (existing) {
        throw new Error('Voucher code already exists');
      }
    }

    const voucher = new AdvanceCash({
      companyId: companyObjectId,
      employeeId: employeeObjectId,
      totalAmount,
      remainingAmount: totalAmount,
      usedAmount: 0,
      currency,
      projectId: params.projectId ? new mongoose.Types.ObjectId(params.projectId) : undefined,
      costCentreId: params.costCentreId ? new mongoose.Types.ObjectId(params.costCentreId) : undefined,
      status: AdvanceCashStatus.ACTIVE,
      voucherCode: params.voucherCode,
      createdBy: new mongoose.Types.ObjectId(params.createdBy),
    });

    const saved = await voucher.save();

    // Create ledger entry
    try {
      const employee = await User.findById(employeeObjectId).select('name email').exec();
      const employeeName = (employee as any)?.name || (employee as any)?.email || 'Employee';
      
      await LedgerService.createEntry({
        companyId: params.companyId,
        entryType: LedgerEntryType.VOUCHER_ISSUED,
        voucherId: (saved._id as mongoose.Types.ObjectId).toString(),
        userId: params.employeeId,
        amount: totalAmount,
        currency,
        debitAccount: 'ADVANCE_CASH_PAID',
        creditAccount: 'EMPLOYEE_ADVANCE',
        description: `Voucher issued to ${employeeName}${params.voucherCode ? ` (Code: ${params.voucherCode})` : ''}`,
        referenceId: params.voucherCode || (saved._id as mongoose.Types.ObjectId).toString(),
        entryDate: new Date(),
        createdBy: params.createdBy,
      });
    } catch (error) {
      logger.error({ error, voucherId: saved._id }, 'Failed to create ledger entry for voucher creation');
      // Don't fail voucher creation if ledger entry fails
    }

    // Log audit entry
    await AuditService.log(
      params.createdBy,
      'AdvanceCash',
      (saved._id as mongoose.Types.ObjectId).toString(),
      AuditAction.CREATE,
      {
        totalAmount,
        currency,
        employeeId: params.employeeId,
        voucherCode: params.voucherCode,
      }
    );

    return saved;
  }

  /**
   * Get available vouchers for selection (for a specific report)
   */
  static async getAvailableVouchers(params: {
    companyId: string;
    employeeId: string;
    reportId?: string;
    currency?: string;
    projectId?: string;
    costCentreId?: string;
  }): Promise<IAdvanceCash[]> {
    // Build base query - be lenient with status and amount checks
    const query: any = {
      companyId: new mongoose.Types.ObjectId(params.companyId),
      employeeId: new mongoose.Types.ObjectId(params.employeeId),
      // Check status - include ACTIVE and PARTIAL
      status: { $in: [AdvanceCashStatus.ACTIVE, AdvanceCashStatus.PARTIAL] },
      // Handle both new (remainingAmount) and legacy (balance) field names
      // Show vouchers where either remainingAmount > 0 OR balance > 0
      $or: [
        { remainingAmount: { $gt: 0 } },
        { balance: { $gt: 0 } },
      ],
    };

    // Note: Currency filter is optional - show vouchers of any currency
    // Users can use vouchers regardless of report currency (conversion handled separately)
    // if (params.currency) {
    //   query.currency = params.currency.toUpperCase();
    // }

    // Note: Project/Cost Centre filtering removed - show ALL user vouchers
    // Users should be able to use any voucher they have, regardless of project/cost centre matching
    // Project/cost centre is metadata for tracking, not a restriction on usage

    // Exclude vouchers already used in submitted reports (if reportId provided, exclude it)
    // Note: Vouchers can be used across multiple reports, so we only exclude if already used in OTHER reports
    let usedVoucherIds: mongoose.Types.ObjectId[] = [];
    if (params.reportId) {
      // Only exclude vouchers used in OTHER reports (not the current one)
      const usedInOtherReports = await VoucherUsage.find({
        reportId: { $ne: new mongoose.Types.ObjectId(params.reportId) },
        status: VoucherUsageStatus.APPLIED,
      })
        .distinct('voucherId')
        .exec();
      
      usedVoucherIds = usedInOtherReports;
      
      logger.info({
        reportId: params.reportId,
        usedInOtherReportsCount: usedVoucherIds.length,
        usedVoucherIds: usedVoucherIds.map(id => id.toString()),
      }, 'Vouchers used in other reports');
    }
    // Note: We don't exclude vouchers used in submitted reports when reportId is provided
    // because vouchers can be reused across multiple reports

    if (usedVoucherIds.length > 0) {
      query._id = { $nin: usedVoucherIds };
    }

    // Debug logging
    logger.info({
      companyId: params.companyId,
      employeeId: params.employeeId,
      reportId: params.reportId,
      query: JSON.stringify(query),
      usedVoucherIdsCount: usedVoucherIds.length,
    }, 'Fetching available vouchers');

    // First, let's check all vouchers for this user to debug
    const allUserVouchers = await AdvanceCash.find({
      companyId: new mongoose.Types.ObjectId(params.companyId),
      employeeId: new mongoose.Types.ObjectId(params.employeeId),
    })
      .select('_id status remainingAmount balance totalAmount amount')
      .exec();

    logger.info({
      allVouchersCount: allUserVouchers.length,
      allVouchers: allUserVouchers.map(v => ({
        id: (v._id as mongoose.Types.ObjectId).toString(),
        status: v.status,
        remainingAmount: v.remainingAmount,
        balance: v.balance,
        totalAmount: v.totalAmount,
        amount: v.amount,
      })),
    }, 'All user vouchers (for debugging)');

    const vouchers = await AdvanceCash.find(query)
      .sort({ createdAt: -1 })
      .populate('projectId', 'name code')
      .populate('costCentreId', 'name code')
      .exec();

    logger.info({
      voucherCount: vouchers.length,
      voucherIds: vouchers.map(v => (v._id as mongoose.Types.ObjectId).toString()),
      voucherDetails: vouchers.map(v => ({
        id: (v._id as mongoose.Types.ObjectId).toString(),
        status: v.status,
        remainingAmount: v.remainingAmount,
        balance: v.balance,
        totalAmount: v.totalAmount,
      })),
    }, 'Found available vouchers');

    return vouchers;
  }

  /**
   * Apply voucher to a report (atomic transaction)
   * Called when user submits a DRAFT report
   */
  static async applyVoucherToReport(params: {
    voucherId: string;
    reportId: string;
    amount: number;
    userId: string;
  }): Promise<IVoucherUsage> {
    // Validate voucherId format
    if (!mongoose.Types.ObjectId.isValid(params.voucherId)) {
      throw new Error(`Invalid voucher ID format: ${params.voucherId}`);
    }
    
    // Validate reportId format
    if (!mongoose.Types.ObjectId.isValid(params.reportId)) {
      throw new Error(`Invalid report ID format: ${params.reportId}`);
    }
    
    // Validate userId format
    if (!mongoose.Types.ObjectId.isValid(params.userId)) {
      throw new Error(`Invalid user ID format: ${params.userId}`);
    }
    
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const voucherObjectId = new mongoose.Types.ObjectId(params.voucherId);
      const reportObjectId = new mongoose.Types.ObjectId(params.reportId);
      const userObjectId = new mongoose.Types.ObjectId(params.userId);

      // Load voucher with lock
      const voucher = await AdvanceCash.findById(voucherObjectId).session(session).exec();
      if (!voucher) {
        throw new Error('Voucher not found');
      }

      // Load report with lock
      const report = await ExpenseReport.findById(reportObjectId).session(session).exec();
      if (!report) {
        throw new Error('Report not found');
      }

      // Validate report belongs to user
      if (report.userId.toString() !== params.userId) {
        throw new Error('Access denied: Report does not belong to you');
      }

      // Validate report is in DRAFT status
      if (report.status !== ExpenseReportStatus.DRAFT) {
        throw new Error('Voucher can only be applied to DRAFT reports');
      }

      // Validate voucher belongs to user
      if (voucher.employeeId.toString() !== params.userId) {
        throw new Error('Access denied: Voucher does not belong to you');
      }

      // Validate voucher is available
      if (voucher.status === AdvanceCashStatus.EXHAUSTED || voucher.status === AdvanceCashStatus.RETURNED) {
        throw new Error('Voucher is not available for use');
      }

      if (voucher.remainingAmount <= 0) {
        throw new Error('Voucher has no remaining balance');
      }

      // Validate amount
      const amount = Number(params.amount);
      if (!isFinite(amount) || amount <= 0) {
        throw new Error('Amount must be greater than 0');
      }

      if (amount > voucher.remainingAmount) {
        throw new Error(`Amount exceeds voucher balance. Available: ${voucher.remainingAmount} ${voucher.currency}`);
      }

      // Check if voucher is already used in this report
      const existingUsage = await VoucherUsage.findOne({
        voucherId: voucherObjectId,
        reportId: reportObjectId,
      })
        .session(session)
        .exec();

      if (existingUsage) {
        throw new Error('Voucher is already applied to this report');
      }

      // Check if report already has a voucher
      const existingReportUsage = await VoucherUsage.findOne({
        reportId: reportObjectId,
        status: VoucherUsageStatus.APPLIED,
      })
        .session(session)
        .exec();

      if (existingReportUsage) {
        throw new Error('Report already has a voucher applied');
      }

      // Get company ID from user
      const user = await User.findById(userObjectId).select('companyId').session(session).exec();
      if (!user || !user.companyId) {
        throw new Error('User company not found');
      }

      // Create voucher usage entry
      const voucherUsage = new VoucherUsage({
        voucherId: voucherObjectId,
        reportId: reportObjectId,
        userId: userObjectId,
        companyId: user.companyId,
        amountUsed: amount,
        currency: voucher.currency,
        appliedAt: new Date(),
        appliedBy: userObjectId,
        status: VoucherUsageStatus.APPLIED,
      });

      await voucherUsage.save({ session });

      // Update voucher
      voucher.usedAmount = (voucher.usedAmount || 0) + amount;
      voucher.remainingAmount = voucher.remainingAmount - amount;
      
      // Update status based on remaining amount
      voucher.status = this.calculateVoucherStatus(voucher);
      
      await voucher.save({ session });

      // Update report
      report.advanceCashId = voucherObjectId;
      report.advanceAppliedAmount = amount;
      report.advanceCurrency = voucher.currency;
      report.voucherLockedAt = new Date();
      report.voucherLockedBy = userObjectId;
      
      await report.save({ session });

      // Create ledger entry
      try {
        await LedgerService.createEntry({
          companyId: user.companyId.toString(),
          entryType: LedgerEntryType.VOUCHER_USED,
          voucherId: params.voucherId,
          reportId: params.reportId,
          userId: params.userId,
          amount: amount,
          currency: voucher.currency,
          debitAccount: 'EMPLOYEE_ADVANCE',
          creditAccount: 'EXPENSE_REPORT_ADVANCE',
          description: `Voucher used for report: ${report.name}${voucher.voucherCode ? ` (Voucher: ${voucher.voucherCode})` : ''}`,
          referenceId: voucher.voucherCode || params.voucherId,
          entryDate: new Date(),
          createdBy: params.userId,
        });
      } catch (error) {
        logger.error({ error, voucherId: params.voucherId, reportId: params.reportId }, 'Failed to create ledger entry for voucher usage');
        // Don't fail transaction if ledger entry fails
      }

      // Log audit entry
      await AuditService.log(
        params.userId,
        'VoucherUsage',
        (voucherUsage._id as mongoose.Types.ObjectId).toString(),
        AuditAction.CREATE,
        {
          voucherId: params.voucherId,
          reportId: params.reportId,
          amountUsed: amount,
          currency: voucher.currency,
        }
      );

      await session.commitTransaction();

      return voucherUsage;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Get voucher usage history
   */
  static async getVoucherUsageHistory(voucherId: string): Promise<IVoucherUsage[]> {
    if (!mongoose.Types.ObjectId.isValid(voucherId)) {
      throw new Error('Invalid voucher ID');
    }

    return VoucherUsage.find({
      voucherId: new mongoose.Types.ObjectId(voucherId),
    })
      .populate('reportId', 'name status totalAmount currency')
      .populate('appliedBy', 'name email')
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Calculate voucher status based on remaining amount
   */
  static calculateVoucherStatus(voucher: IAdvanceCash): AdvanceCashStatus {
    if (voucher.status === AdvanceCashStatus.RETURNED) {
      return AdvanceCashStatus.RETURNED;
    }

    if (voucher.remainingAmount === 0) {
      return AdvanceCashStatus.EXHAUSTED;
    }

    if (voucher.remainingAmount < voucher.totalAmount) {
      return AdvanceCashStatus.PARTIAL;
    }

    return AdvanceCashStatus.ACTIVE;
  }

  /**
   * Get voucher details with usage history and ledger entries
   */
  static async getVoucherDetails(voucherId: string): Promise<{
    voucher: IAdvanceCash;
    usageHistory: IVoucherUsage[];
    ledgerEntries: any[];
  }> {
    if (!mongoose.Types.ObjectId.isValid(voucherId)) {
      throw new Error('Invalid voucher ID');
    }

    const voucher = await AdvanceCash.findById(voucherId)
      .populate('employeeId', 'name email')
      .populate('projectId', 'name code')
      .populate('costCentreId', 'name code')
      .populate('createdBy', 'name email')
      .exec();

    if (!voucher) {
      throw new Error('Voucher not found');
    }

    const usageHistory = await this.getVoucherUsageHistory(voucherId);
    const ledgerEntries = await LedgerService.getVoucherLedger(voucherId);

    return {
      voucher,
      usageHistory,
      ledgerEntries,
    };
  }

  /**
   * Get voucher dashboard stats for admin
   */
  static async getVoucherDashboard(companyId: string): Promise<{
    issuedAmount: number;
    usedAmount: number;
    remainingAmount: number;
    returnedAmount: number;
    statusCounts: {
      ACTIVE: number;
      PARTIAL: number;
      EXHAUSTED: number;
      RETURNED: number;
    };
    userConsumption: Array<{
      userId: string;
      userName: string;
      userEmail: string;
      issuedAmount: number;
      usedAmount: number;
      remainingAmount: number;
    }>;
  }> {
    const companyObjectId = new mongoose.Types.ObjectId(companyId);

    // Aggregate voucher stats
    const [totalStats, statusCounts, userStats] = await Promise.all([
      AdvanceCash.aggregate([
        { $match: { companyId: companyObjectId } },
        {
          $group: {
            _id: null,
            issuedAmount: { $sum: '$totalAmount' },
            usedAmount: { $sum: '$usedAmount' },
            remainingAmount: { $sum: '$remainingAmount' },
            returnedAmount: { $sum: '$returnedAmount' },
          },
        },
      ]),
      AdvanceCash.aggregate([
        { $match: { companyId: companyObjectId } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      AdvanceCash.aggregate([
        { $match: { companyId: companyObjectId } },
        {
          $group: {
            _id: '$employeeId',
            issuedAmount: { $sum: '$totalAmount' },
            usedAmount: { $sum: '$usedAmount' },
            remainingAmount: { $sum: '$remainingAmount' },
          },
        },
      ]),
    ]);

    const stats = totalStats[0] || {
      issuedAmount: 0,
      usedAmount: 0,
      remainingAmount: 0,
      returnedAmount: 0,
    };

    const statusMap: Record<string, number> = {
      ACTIVE: 0,
      PARTIAL: 0,
      EXHAUSTED: 0,
      RETURNED: 0,
    };

    statusCounts.forEach((item) => {
      statusMap[item._id] = item.count;
    });

    // Get user details for consumption breakdown
    const userIds = userStats.map((s) => s._id);
    const users = await User.find({ _id: { $in: userIds } })
      .select('name email')
      .exec();

    const userMap = new Map(
      users.map((u) => [(u._id as mongoose.Types.ObjectId).toString(), { name: u.name, email: u.email }])
    );

    const userConsumption = userStats.map((stat) => {
      const user = userMap.get(stat._id.toString());
      return {
        userId: stat._id.toString(),
        userName: user?.name || 'Unknown',
        userEmail: user?.email || 'Unknown',
        issuedAmount: stat.issuedAmount || 0,
        usedAmount: stat.usedAmount || 0,
        remainingAmount: stat.remainingAmount || 0,
      };
    });

    return {
      issuedAmount: stats.issuedAmount || 0,
      usedAmount: stats.usedAmount || 0,
      remainingAmount: stats.remainingAmount || 0,
      returnedAmount: stats.returnedAmount || 0,
      statusCounts: {
        ACTIVE: statusMap.ACTIVE || 0,
        PARTIAL: statusMap.PARTIAL || 0,
        EXHAUSTED: statusMap.EXHAUSTED || 0,
        RETURNED: statusMap.RETURNED || 0,
      },
      userConsumption,
    };
  }
}

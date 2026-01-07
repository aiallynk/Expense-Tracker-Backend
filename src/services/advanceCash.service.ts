import mongoose from 'mongoose';

import { AdvanceCash, AdvanceCashStatus, IAdvanceCash } from '../models/AdvanceCash';
import { AdvanceCashTransaction } from '../models/AdvanceCashTransaction';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { ExpenseReportStatus } from '../utils/enums';

import { logger } from '@/config/logger';

export class AdvanceCashService {
  static async createAdvance(params: {
    companyId: string;
    employeeId: string;
    amount: number;
    currency?: string;
    projectId?: string;
    costCentreId?: string;
    createdBy: string;
  }): Promise<IAdvanceCash> {
    const companyObjectId = new mongoose.Types.ObjectId(params.companyId);
    const employeeObjectId = new mongoose.Types.ObjectId(params.employeeId);

    const amount = Number(params.amount);
    if (!isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    const currency = (params.currency || 'INR').toUpperCase();

    const advance = new AdvanceCash({
      companyId: companyObjectId,
      employeeId: employeeObjectId,
      amount,
      balance: amount,
      currency,
      projectId: params.projectId ? new mongoose.Types.ObjectId(params.projectId) : undefined,
      costCentreId: params.costCentreId ? new mongoose.Types.ObjectId(params.costCentreId) : undefined,
      status: AdvanceCashStatus.ACTIVE,
      createdBy: new mongoose.Types.ObjectId(params.createdBy),
    });

    return await advance.save();
  }

  static async listEmployeeAdvances(params: {
    companyId: string;
    employeeId: string;
  }): Promise<IAdvanceCash[]> {
    return AdvanceCash.find({
      companyId: new mongoose.Types.ObjectId(params.companyId),
      employeeId: new mongoose.Types.ObjectId(params.employeeId),
    })
      .sort({ status: 1, createdAt: -1 })
      .populate('projectId', 'name code')
      .populate('costCentreId', 'name code')
      .populate('createdBy', 'name email')
      .exec();
  }

  static async getEmployeeAvailableBalance(params: {
    companyId: string;
    employeeId: string;
    currency?: string;
    projectId?: string;
    costCentreId?: string;
  }): Promise<{
    currency: string;
    totalBalance: number;
    scopedBalance: number;
  }> {
    const currency = (params.currency || 'INR').toUpperCase();
    const companyId = new mongoose.Types.ObjectId(params.companyId);
    const employeeId = new mongoose.Types.ObjectId(params.employeeId);

    const base = {
      companyId,
      employeeId,
      currency,
      status: AdvanceCashStatus.ACTIVE,
      balance: { $gt: 0 },
    };

    const totalAgg = await AdvanceCash.aggregate([
      { $match: base },
      { $group: { _id: null, total: { $sum: '$balance' } } },
    ]);

    const totalBalance = Number(totalAgg?.[0]?.total || 0);

    // scopedBalance: what would be usable for an expense with the given scope:
    // (project match OR cost-centre match OR unscoped)
    const scopeOr: any[] = [];
    if (params.projectId && mongoose.Types.ObjectId.isValid(params.projectId)) {
      scopeOr.push({ projectId: new mongoose.Types.ObjectId(params.projectId) });
    }
    if (params.costCentreId && mongoose.Types.ObjectId.isValid(params.costCentreId)) {
      scopeOr.push({ costCentreId: new mongoose.Types.ObjectId(params.costCentreId) });
    }
    scopeOr.push({ projectId: { $exists: false }, costCentreId: { $exists: false } });
    scopeOr.push({ projectId: null, costCentreId: null });

    const scopedAgg = await AdvanceCash.aggregate([
      { $match: { ...base, $or: scopeOr } },
      { $group: { _id: null, total: { $sum: '$balance' } } },
    ]);

    const scopedBalance = Number(scopedAgg?.[0]?.total || 0);

    return { currency, totalBalance, scopedBalance };
  }

  /**
   * Apply (deduct) advances for a report. Called only when report is finally APPROVED.
   * Idempotent per expense via AdvanceCashTransaction unique expenseId.
   */
  static async applyAdvanceForReport(reportId: string): Promise<{
    appliedExpenses: number;
    skippedExpenses: number;
  }> {
    if (!mongoose.Types.ObjectId.isValid(reportId)) {
      throw new Error('Invalid reportId');
    }

    const report = await ExpenseReport.findById(reportId).select('userId status').exec();
    if (!report) {
      throw new Error('Report not found');
    }

    if (report.status !== ExpenseReportStatus.APPROVED) {
      // We only apply on final approved. No-op otherwise.
      return { appliedExpenses: 0, skippedExpenses: 0 };
    }

    const owner = await User.findById(report.userId).select('companyId').exec();
    const companyId = owner?.companyId;
    if (!companyId) {
      return { appliedExpenses: 0, skippedExpenses: 0 };
    }

    const expenses = await Expense.find({
      reportId: new mongoose.Types.ObjectId(reportId),
      advanceAppliedAmount: { $gt: 0 },
    })
      .select('amount currency projectId costCentreId advanceAppliedAmount advanceAppliedAt')
      .exec();

    if (expenses.length === 0) {
      return { appliedExpenses: 0, skippedExpenses: 0 };
    }

    let appliedExpenses = 0;
    let skippedExpenses = 0;

    // Skip transactions in test environment
    const isTestEnv = process.env.NODE_ENV === 'test';
    const session = isTestEnv ? null : await mongoose.startSession();

    try {
      const transactionFn = async () => {
        for (const expense of expenses) {
          const expenseId = expense._id as mongoose.Types.ObjectId;

          // Idempotency: if a transaction exists, skip.
          const existingTx = await AdvanceCashTransaction.findOne({ expenseId }).session(session || null).exec();
          if (existingTx) {
            skippedExpenses += 1;
            continue;
          }

          const desired = Math.min(
            Number(expense.advanceAppliedAmount || 0),
            Number(expense.amount || 0)
          );

          if (!isFinite(desired) || desired <= 0) {
            skippedExpenses += 1;
            continue;
          }

          const currency = String(expense.currency || 'INR').toUpperCase();

          const tiers: Array<any> = [];
          const employeeId = report.userId as mongoose.Types.ObjectId;

          // Tier 1: project-scoped advances (if expense has projectId)
          if (expense.projectId) {
            tiers.push({
              companyId,
              employeeId,
              currency,
              status: AdvanceCashStatus.ACTIVE,
              balance: { $gt: 0 },
              projectId: expense.projectId,
            });
          }

          // Tier 2: cost-centre-scoped advances (if expense has costCentreId)
          if (expense.costCentreId) {
            tiers.push({
              companyId,
              employeeId,
              currency,
              status: AdvanceCashStatus.ACTIVE,
              balance: { $gt: 0 },
              costCentreId: expense.costCentreId,
              projectId: { $in: [null, undefined] },
            });
          }

          // Tier 3: unscoped advances
          tiers.push({
            companyId,
            employeeId,
            currency,
            status: AdvanceCashStatus.ACTIVE,
            balance: { $gt: 0 },
            projectId: { $in: [null, undefined] },
            costCentreId: { $in: [null, undefined] },
          });

          let remaining = desired;
          const allocations: Array<{ advanceCashId: mongoose.Types.ObjectId; amount: number }> = [];

          for (const q of tiers) {
            if (remaining <= 0) break;
            const advances = await AdvanceCash.find(q).sort({ createdAt: 1 }).session(session || null).exec();
            for (const adv of advances) {
              if (remaining <= 0) break;
              const available = Number(adv.balance || 0);
              if (available <= 0) continue;

              const use = Math.min(remaining, available);
              if (use <= 0) continue;

              adv.balance = Number(adv.balance) - use;
              if (adv.balance <= 0) {
                adv.balance = 0;
                adv.status = AdvanceCashStatus.SETTLED;
              }
              await adv.save({ session });

              allocations.push({
                advanceCashId: adv._id as mongoose.Types.ObjectId,
                amount: use,
              });
              remaining -= use;
            }
          }

          const totalApplied = allocations.reduce((sum, a) => sum + a.amount, 0);

          // Always create a transaction row (even if 0) only when we actually apply.
          if (totalApplied > 0) {
            await AdvanceCashTransaction.create(
              [
                {
                  companyId,
                  employeeId: report.userId,
                  expenseId,
                  reportId: new mongoose.Types.ObjectId(reportId),
                  amount: totalApplied,
                  currency,
                  allocations,
                },
              ],
              { session }
            );

            expense.advanceAppliedAmount = totalApplied;
            expense.advanceAppliedAt = new Date();
            await expense.save({ session });
            appliedExpenses += 1;
          } else {
            skippedExpenses += 1;
          }
        }
      };

      if (isTestEnv) {
        await transactionFn();
      } else {
        await session!.withTransaction(transactionFn);
      }
    } catch (error) {
      logger.error({ error, reportId }, 'Failed to apply advance cash for report');
      throw error;
    } finally {
      if (session) {
        await session.endSession();
      }
    }

    return { appliedExpenses, skippedExpenses };
  }
}



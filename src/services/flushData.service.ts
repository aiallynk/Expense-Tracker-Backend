import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { Receipt } from '../models/Receipt';
import { User } from '../models/User';
import { ApprovalInstance } from '../models/ApprovalInstance';
import { getCompanyUserIds } from '../utils/companyAccess';
import { logger } from '@/config/logger';

export interface FlushDataOptions {
  companyId: string;
  flushExpenses: boolean;
  flushReports: boolean;
  flushUsers: boolean;
}

export interface FlushDataResult {
  deletedExpenses: number;
  deletedReceipts: number;
  deletedReports: number;
  deletedApprovalInstances: number;
  deletedUsers: number;
  errors?: string[];
}

/**
 * Permanently delete company data based on selected options.
 * Order: expenses (and receipts) -> reports (and related) -> users.
 */
export async function flushCompanyData(options: FlushDataOptions): Promise<FlushDataResult> {
  const { companyId, flushExpenses, flushReports, flushUsers } = options;
  const result: FlushDataResult = {
    deletedExpenses: 0,
    deletedReceipts: 0,
    deletedReports: 0,
    deletedApprovalInstances: 0,
    deletedUsers: 0,
  };
  const errors: string[] = [];

  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    throw new Error('Invalid company ID');
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const userIds = await getCompanyUserIds(companyId);
  if (userIds.length === 0 && (flushExpenses || flushReports || flushUsers)) {
    logger.warn({ companyId }, 'Flush data: no company users found');
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (flushExpenses || flushReports) {
      if (flushExpenses) {
        const expenses = await Expense.find({ userId: { $in: userIds } })
          .select('_id receiptIds')
          .session(session)
          .lean()
          .exec();
        const allReceiptIds: mongoose.Types.ObjectId[] = [];
        for (const e of expenses) {
          if (e.receiptIds && Array.isArray(e.receiptIds)) {
            allReceiptIds.push(...e.receiptIds);
          }
        }
        if (allReceiptIds.length > 0) {
          const receiptResult = await Receipt.deleteMany({ _id: { $in: allReceiptIds } }).session(session);
          result.deletedReceipts = receiptResult.deletedCount ?? 0;
        }
        const expResult = await Expense.deleteMany({ userId: { $in: userIds } }).session(session);
        result.deletedExpenses = expResult.deletedCount ?? 0;
      }

      if (flushReports) {
        const reports = await ExpenseReport.find({ userId: { $in: userIds } })
          .select('_id')
          .session(session)
          .lean()
          .exec();
        const reportIds = reports.map((r: any) => r._id);

        if (reportIds.length > 0) {
          // Delete approval instances for these reports
          const instResult = await ApprovalInstance.deleteMany({ requestId: { $in: reportIds } }).session(session);
          result.deletedApprovalInstances = instResult.deletedCount ?? 0;

          // Delete expenses under these reports (and their receipts) — only if we didn't already delete all expenses above
          if (!flushExpenses) {
            const reportExpenses = await Expense.find({ reportId: { $in: reportIds } })
              .select('_id receiptIds')
              .session(session)
              .lean()
              .exec();
            const reportReceiptIds: mongoose.Types.ObjectId[] = [];
            for (const e of reportExpenses) {
              if (e.receiptIds && Array.isArray(e.receiptIds)) {
                reportReceiptIds.push(...e.receiptIds);
              }
            }
            if (reportReceiptIds.length > 0) {
              const recDel = await Receipt.deleteMany({ _id: { $in: reportReceiptIds } }).session(session);
              result.deletedReceipts += recDel.deletedCount ?? 0;
            }
            const expDel = await Expense.deleteMany({ reportId: { $in: reportIds } }).session(session);
            result.deletedExpenses += expDel.deletedCount ?? 0;
          }

          // Delete report-related records (VoucherUsage, AdvanceCashTransaction, Ledger if they exist)
          try {
            const { VoucherUsage } = await import('../models/VoucherUsage');
            await VoucherUsage.deleteMany({ reportId: { $in: reportIds } }).session(session);
          } catch (e) {
            errors.push(`VoucherUsage: ${(e as Error).message}`);
          }
          try {
            const { AdvanceCashTransaction } = await import('../models/AdvanceCashTransaction');
            await AdvanceCashTransaction.deleteMany({ reportId: { $in: reportIds } }).session(session);
          } catch (e) {
            errors.push(`AdvanceCashTransaction: ${(e as Error).message}`);
          }
          try {
            const { Ledger } = await import('../models/Ledger');
            await Ledger.deleteMany({ reportId: { $in: reportIds } }).session(session);
          } catch (e) {
            errors.push(`Ledger: ${(e as Error).message}`);
          }
        }

        const reportResult = await ExpenseReport.deleteMany({ userId: { $in: userIds } }).session(session);
        result.deletedReports = reportResult.deletedCount ?? 0;
      }
    }

    if (flushUsers) {
      const userResult = await User.deleteMany({ companyId: companyObjectId }).session(session);
      result.deletedUsers = userResult.deletedCount ?? 0;
    }

    if (errors.length > 0) {
      result.errors = errors;
    }

    await session.commitTransaction();
    logger.info({ companyId, result }, 'Flush company data completed');
    return result;
  } catch (error) {
    await session.abortTransaction();
    logger.error({ error, companyId }, 'Flush company data failed');
    throw error;
  } finally {
    session.endSession();
  }
}

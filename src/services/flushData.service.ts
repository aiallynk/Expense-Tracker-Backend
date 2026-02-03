import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { Receipt } from '../models/Receipt';
import { User } from '../models/User';
import { ApprovalInstance } from '../models/ApprovalInstance';
import { getCompanyUserIds } from '../utils/companyAccess';
import { logger } from '@/config/logger';
import { ExpenseReportStatus, ExpenseStatus } from '../utils/enums';
import { rebuildSnapshotsForCompany, getDashboardPayload } from './companyAnalyticsSnapshot.service';
import { emitCompanyAdminDashboardUpdate } from '../socket/realtimeEvents';

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

// Explicitly include all statuses so REJECTED (and any other) reports/expenses are always flushed
const ALL_REPORT_STATUSES = Object.values(ExpenseReportStatus);
const ALL_EXPENSE_STATUSES = Object.values(ExpenseStatus);

/**
 * Permanently delete company data based on selected options.
 * Includes all statuses: DRAFT, SUBMITTED, REJECTED, APPROVED, CHANGES_REQUESTED, etc.
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
        // All expenses for company users (any status: DRAFT, PENDING, APPROVED, REJECTED)
        const expenseQuery = { userId: { $in: userIds }, status: { $in: ALL_EXPENSE_STATUSES } };
        const expenses = await Expense.find(expenseQuery)
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
        const expResult = await Expense.deleteMany(expenseQuery).session(session);
        result.deletedExpenses = expResult.deletedCount ?? 0;
      }

      if (flushReports) {
        // All reports for company users (any status: DRAFT, SUBMITTED, REJECTED, APPROVED, etc.)
        const reportQuery = { userId: { $in: userIds }, status: { $in: ALL_REPORT_STATUSES } };
        const reports = await ExpenseReport.find(reportQuery)
          .select('_id')
          .session(session)
          .lean()
          .exec();
        const reportIds = reports.map((r: any) => r._id);

        if (reportIds.length > 0) {
          // Delete approval instances for these reports
          const instResult = await ApprovalInstance.deleteMany({ requestId: { $in: reportIds } }).session(session);
          result.deletedApprovalInstances = instResult.deletedCount ?? 0;

          // Delete expenses under these reports (and their receipts) — only if we didn't already delete all expenses above. Include all statuses (e.g. REJECTED).
          if (!flushExpenses) {
            const reportExpenseQuery = { reportId: { $in: reportIds }, status: { $in: ALL_EXPENSE_STATUSES } };
            const reportExpenses = await Expense.find(reportExpenseQuery)
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
            const expDel = await Expense.deleteMany(reportExpenseQuery).session(session);
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

        const reportResult = await ExpenseReport.deleteMany(reportQuery).session(session);
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

    // Reset dashboard insights when expense/report (or user) data was flushed so amounts show as 0
    if (flushExpenses || flushReports || flushUsers) {
      try {
        await rebuildSnapshotsForCompany(companyId);
        const payload = await getDashboardPayload(companyId);
        emitCompanyAdminDashboardUpdate(companyId, payload);
        logger.info({ companyId }, 'Analytics snapshots rebuilt and dashboard emitted after flush');
      } catch (insightError) {
        logger.error({ error: insightError, companyId }, 'Failed to rebuild analytics snapshots after flush');
        errors.push(`Analytics reset: ${(insightError as Error).message}`);
        result.errors = errors;
        // Do not throw: flush already succeeded; insights will correct on next rebuild or page load
      }
    }

    return result;
  } catch (error) {
    await session.abortTransaction();
    logger.error({ error, companyId }, 'Flush company data failed');
    throw error;
  } finally {
    session.endSession();
  }
}

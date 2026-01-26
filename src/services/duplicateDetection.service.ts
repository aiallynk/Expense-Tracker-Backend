/**
 * Duplicate Detection Service - COMPANY-LEVEL (flag-only; never blocks submission)
 *
 * IMPORTANT: This service performs COMPANY-WIDE duplicate detection.
 * - Checks expenses across ALL users within the same company
 * - Excludes REJECTED expenses and expenses from REJECTED/CANCELLED reports
 * - Does NOT expose other users' data - only sets duplicate flags
 * 
 * Primary data source priority: Receipt OCR / parsed invoice → parsed metadata → notes (fallback only).
 * Matching: vendor_name (normalized), amount (2 decimals), date (UTC ±1 day), invoice_id (optional).
 * Rules:
 * - Any 3 of { vendor, amount, date, invoice_id } match within same company → POTENTIAL_DUPLICATE
 * - invoice_id match within same company → STRONG_DUPLICATE
 * 
 * Stores duplicateFlag, duplicateReason on expense. Exposed to approver & company admin.
 * Users see warning: "This expense appears similar to another expense submitted in your company."
 */

import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { User } from '../models/User';

import { logger } from '@/config/logger';

export type DuplicateFlag = 'POTENTIAL_DUPLICATE' | 'STRONG_DUPLICATE';

export interface DuplicateCheckResult {
  duplicateFlag: DuplicateFlag | null;
  duplicateReason: string | null;
}

/** Normalize vendor: lowercase, trim, remove special chars */
function normalizeVendor(v: string): string {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Amount rounded to 2 decimals */
function normalizeAmount(a: number): number {
  return Math.round(Number(a) * 100) / 100;
}

/** ±1 day UTC bounds for querying */
function dayBoundsUtcPlusMinusOne(date: Date): { start: Date; end: Date } {
  const dt = new Date(date);
  const start = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() + 2, 0, 0, 0, 0));
  return { start, end };
}

/** Normalize invoice_id for comparison: trim, lowercase, remove special chars */
function normalizeInvoiceId(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export class DuplicateDetectionService {
  /**
   * Check for duplicates BEFORE saving an expense (used to block saving).
   * This is a read-only check that doesn't require an existing expense.
   * Uses the same logic as runDuplicateCheck but works with expense data instead of expenseId.
   * 
   * IMPORTANT: This is COMPANY-WIDE duplicate detection.
   * Returns duplicateFlag and duplicateReason if duplicate is found.
   */
  static async checkForDuplicateBeforeSave(
    expenseData: {
      vendor: string;
      amount: number;
      expenseDate?: Date;
      invoiceDate?: Date;
      invoiceId?: string;
      currency?: string;
      originalAmount?: number;
      originalCurrency?: string;
    },
    companyId: mongoose.Types.ObjectId,
    excludeExpenseId: string | null
  ): Promise<DuplicateCheckResult> {
    try {
      const vendor = (expenseData.vendor || '').trim();
      // Use originalAmount if available (for currency-converted expenses), otherwise use amount
      const amountToCompare = expenseData.originalAmount ?? expenseData.amount ?? 0;
      const amount = normalizeAmount(amountToCompare);
      const dateSource = expenseData.invoiceDate ?? expenseData.expenseDate;
      const invoiceId = (expenseData.invoiceId || '').trim() || undefined;

      if (!vendor || !dateSource || isNaN(new Date(dateSource).getTime())) {
        return { duplicateFlag: null, duplicateReason: null };
      }

      const vendorNorm = normalizeVendor(vendor);
      const { start, end } = dayBoundsUtcPlusMinusOne(new Date(dateSource));

      // Get all users in the company for company-wide duplicate detection
      const companyUsers = await User.find({ companyId }).select('_id').exec();
      const userIds = companyUsers.map((u) => u._id);

      if (userIds.length === 0) {
        return { duplicateFlag: null, duplicateReason: null };
      }

      // Import ExpenseReportStatus to exclude rejected/cancelled reports
      const { ExpenseReportStatus } = await import('../utils/enums');

      // Query for company-wide duplicates - same logic as runDuplicateCheck
      const baseQuery: Record<string, unknown> = {
        userId: { $in: userIds },
        status: { $ne: 'REJECTED' },
        $or: [
          { expenseDate: { $gte: start, $lt: end } },
          { invoiceDate: { $gte: start, $lt: end } },
        ],
      };

      if (excludeExpenseId) {
        baseQuery._id = { $ne: new mongoose.Types.ObjectId(excludeExpenseId) };
      }

      // Find candidate expenses, then filter out those from rejected/cancelled reports
      const allCandidates = await Expense.find(baseQuery as any)
        .select('_id vendor amount originalAmount expenseDate invoiceDate invoiceId currency originalCurrency reportId status')
        .populate({
          path: 'reportId',
          select: 'status',
        })
        .exec();

      // Filter out expenses from REJECTED or CANCELLED reports
      const candidates = allCandidates.filter((candidate: any) => {
        const report = candidate.reportId;
        const reportStatus = report?.status;
        const expenseStatus = candidate.status;
        
        if (expenseStatus === 'REJECTED') {
          return false;
        }
        
        if (reportStatus === ExpenseReportStatus.REJECTED) {
          return false;
        }
        
        return true;
      });

      let strongMatch: (typeof candidates)[0] | null = null;
      let potentialMatch: (typeof candidates)[0] | null = null;
      let potentialReason: string | null = null;

      for (const other of candidates) {
        const ov = (other.vendor || '').trim();
        const otherAmountToCompare = (other as any).originalAmount ?? other.amount ?? 0;
        const oa = normalizeAmount(otherAmountToCompare);
        const od = other.invoiceDate ?? other.expenseDate;
        const oid = (other.invoiceId || '').trim() || undefined;

        if (!od || isNaN(new Date(od).getTime())) continue;

        const ovNorm = normalizeVendor(ov);
        const odMs = new Date(od).getTime();
        const matchDate = odMs >= start.getTime() && odMs < end.getTime();

        const matchVendor = ovNorm === vendorNorm;
        const matchAmount = oa === amount;
        const matchInvoiceId =
          !!invoiceId &&
          !!oid &&
          normalizeInvoiceId(invoiceId) === normalizeInvoiceId(oid);

        // STRONG_DUPLICATE: invoice_id match
        if (matchInvoiceId) {
          strongMatch = other;
          break;
        }

        // POTENTIAL_DUPLICATE: any 3 of { vendor, amount, date, invoice_id } match
        const matchCount = [matchVendor, matchAmount, matchDate, matchInvoiceId].filter(Boolean).length;
        if (matchCount >= 3 && !potentialMatch) {
          const parts: string[] = [];
          if (matchVendor) parts.push('vendor');
          if (matchAmount) parts.push('amount');
          if (matchDate) parts.push('date');
          if (matchInvoiceId) parts.push('invoice_id');
          potentialMatch = other;
          potentialReason = parts.slice(0, 3).join(' + ');
        }
      }

      let flag: DuplicateFlag | null = null;
      let reason: string | null = null;

      if (strongMatch) {
        flag = 'STRONG_DUPLICATE';
        reason = 'invoice_id';
      } else if (potentialMatch && potentialReason) {
        flag = 'POTENTIAL_DUPLICATE';
        reason = potentialReason;
      }

      if (flag != null && reason != null) {
        logger.info({ 
          flag, 
          reason, 
          scope: 'COMPANY',
          companyId: companyId.toString(),
          vendor: vendorNorm,
          amount,
          date: dateSource,
          invoiceId: invoiceId ? 'present' : 'missing',
          candidatesFound: candidates.length,
        }, 'DuplicateDetectionService: Duplicate detected BEFORE save - will block');
      }

      return { duplicateFlag: flag, duplicateReason: reason };
    } catch (error) {
      logger.error({ error, expenseData, companyId }, 'checkForDuplicateBeforeSave failed');
      return { duplicateFlag: null, duplicateReason: null };
    }
  }

  /**
   * Run duplicate check for a single expense at COMPANY level.
   * Updates expense with duplicateFlag/duplicateReason.
   * Never throws; logs errors and returns result.
   * 
   * IMPORTANT: This is COMPANY-WIDE duplicate detection.
   * Users cannot see other users' data - only duplicate flags are set.
   */
  static async runDuplicateCheck(
    expenseId: string,
    companyId?: mongoose.Types.ObjectId
  ): Promise<DuplicateCheckResult> {
    try {
      const expense = await Expense.findById(expenseId)
        .select('userId vendor amount originalAmount expenseDate invoiceId invoiceDate notes reportId currency originalCurrency')
        .populate({
          path: 'reportId',
          select: 'status',
        })
        .exec();
      if (!expense) {
        logger.warn({ expenseId }, 'DuplicateDetectionService: Expense not found');
        return { duplicateFlag: null, duplicateReason: null };
      }

      // Get companyId from expense's user if not provided
      let finalCompanyId = companyId;
      if (!finalCompanyId) {
        const user = await User.findById(expense.userId).select('companyId').exec();
        finalCompanyId = user?.companyId as mongoose.Types.ObjectId | undefined;
      }

      if (!finalCompanyId) {
        logger.warn({ expenseId }, 'DuplicateDetectionService: Company ID not found');
        await Expense.findByIdAndUpdate(expenseId, { $unset: { duplicateFlag: '', duplicateReason: '' } }).exec();
        return { duplicateFlag: null, duplicateReason: null };
      }

      const vendor = (expense.vendor || '').trim();
      // Use originalAmount if available (for currency-converted expenses), otherwise use amount
      const amountToCompare = expense.originalAmount ?? expense.amount ?? 0;
      const amount = normalizeAmount(amountToCompare);
      const dateSource = expense.invoiceDate ?? expense.expenseDate;
      const invoiceId = (expense.invoiceId || '').trim() || undefined;

      if (!vendor || !dateSource || isNaN(new Date(dateSource).getTime())) {
        logger.debug({ expenseId, vendor: vendor || 'missing', dateSource: dateSource || 'missing' }, 'DuplicateDetectionService: Missing required fields');
        await Expense.findByIdAndUpdate(expenseId, { $unset: { duplicateFlag: '', duplicateReason: '' } }).exec();
        return { duplicateFlag: null, duplicateReason: null };
      }

      const vendorNorm = normalizeVendor(vendor);
      const { start, end } = dayBoundsUtcPlusMinusOne(new Date(dateSource));

      // Get all users in the company for company-wide duplicate detection
      const companyUsers = await User.find({ companyId: finalCompanyId }).select('_id').exec();
      const userIds = companyUsers.map((u) => u._id);

      // Import ExpenseReportStatus to exclude rejected/cancelled reports
      const { ExpenseReportStatus } = await import('../utils/enums');

      // Query for company-wide duplicates
      // IMPORTANT: Include DRAFT expenses to detect duplicates even when both expenses are in draft state
      // Exclude: current expense, REJECTED expenses, expenses from REJECTED/CANCELLED reports
      const baseQuery: Record<string, unknown> = {
        _id: { $ne: new mongoose.Types.ObjectId(expenseId) },
        userId: { $in: userIds }, // COMPANY-WIDE: All users in the company
        // Include DRAFT expenses - they should also be checked for duplicates
        status: { $ne: 'REJECTED' }, // Only exclude REJECTED, not DRAFT
        // Exclude expenses from rejected/cancelled reports
        // We'll filter these using aggregation or populate
        $or: [
          { expenseDate: { $gte: start, $lt: end } },
          { invoiceDate: { $gte: start, $lt: end } },
        ],
      };

      // Find candidate expenses, then filter out those from rejected/cancelled reports
      const allCandidates = await Expense.find(baseQuery as any)
        .select('_id vendor amount originalAmount expenseDate invoiceDate invoiceId currency originalCurrency reportId')
        .populate({
          path: 'reportId',
          select: 'status',
        })
        .exec();

      // Filter out expenses from REJECTED or CANCELLED reports
      // Also exclude expenses with REJECTED status
      // IMPORTANT: Include DRAFT expenses - they should be checked for duplicates
      const candidates = allCandidates.filter((candidate: any) => {
        const report = candidate.reportId;
        const reportStatus = report?.status;
        const expenseStatus = candidate.status;
        
        // Exclude if expense is rejected
        if (expenseStatus === 'REJECTED') {
          return false;
        }
        
        // Exclude if report is rejected or cancelled
        // But allow DRAFT reports - expenses in draft reports should be checked for duplicates
        if (reportStatus === ExpenseReportStatus.REJECTED) {
          return false;
        }
        
        // Include all other expenses (DRAFT, SUBMITTED, APPROVED, etc.)
        return true;
      });

      let strongMatch: (typeof candidates)[0] | null = null;
      let potentialMatch: (typeof candidates)[0] | null = null;
      let potentialReason: string | null = null;

      for (const other of candidates) {
        const ov = (other.vendor || '').trim();
        // Use originalAmount if available (for currency-converted expenses), otherwise use amount
        const otherAmountToCompare = (other as any).originalAmount ?? other.amount ?? 0;
        const oa = normalizeAmount(otherAmountToCompare);
        const od = other.invoiceDate ?? other.expenseDate;
        const oid = (other.invoiceId || '').trim() || undefined;

        if (!od || isNaN(new Date(od).getTime())) continue;

        const ovNorm = normalizeVendor(ov);
        const odMs = new Date(od).getTime();
        const matchDate = odMs >= start.getTime() && odMs < end.getTime();

        const matchVendor = ovNorm === vendorNorm;
        const matchAmount = oa === amount;
        const matchInvoiceId =
          !!invoiceId &&
          !!oid &&
          normalizeInvoiceId(invoiceId) === normalizeInvoiceId(oid);

        // STRONG_DUPLICATE: invoice_id match (optional vendor/amount/date tolerance per plan)
        if (matchInvoiceId) {
          strongMatch = other;
          break;
        }

        // POTENTIAL_DUPLICATE: any 3 of { vendor, amount, date, invoice_id } match
        const matchCount = [matchVendor, matchAmount, matchDate, matchInvoiceId].filter(Boolean).length;
        if (matchCount >= 3 && !potentialMatch) {
          const parts: string[] = [];
          if (matchVendor) parts.push('vendor');
          if (matchAmount) parts.push('amount');
          if (matchDate) parts.push('date');
          if (matchInvoiceId) parts.push('invoice_id');
          potentialMatch = other;
          potentialReason = parts.slice(0, 3).join(' + ');
        }
      }

      let flag: DuplicateFlag | null = null;
      let reason: string | null = null;

      if (strongMatch) {
        flag = 'STRONG_DUPLICATE';
        reason = 'invoice_id';
      } else if (potentialMatch && potentialReason) {
        flag = 'POTENTIAL_DUPLICATE';
        reason = potentialReason;
      }

      if (flag != null && reason != null) {
        // Store company-level duplicate flag (without exposing other users' data)
        // DO NOT store matchedExpenseId or matchedUserId - this would expose other users' data
        await Expense.findByIdAndUpdate(expenseId, { 
          duplicateFlag: flag, 
          duplicateReason: reason,
        }).exec();
        logger.info({ 
          expenseId, 
          flag, 
          reason, 
          scope: 'COMPANY',
          companyId: finalCompanyId?.toString(),
          vendor: vendorNorm,
          amount,
          date: dateSource,
          invoiceId: invoiceId ? 'present' : 'missing',
          candidatesFound: candidates.length,
        }, 'DuplicateDetectionService: Company-level duplicate detected');
      } else {
        await Expense.findByIdAndUpdate(expenseId, { $unset: { duplicateFlag: '', duplicateReason: '' } }).exec();
        logger.debug({ 
          expenseId,
          companyId: finalCompanyId?.toString(),
          candidatesFound: candidates.length,
        }, 'DuplicateDetectionService: No duplicate found');
      }

      return { duplicateFlag: flag, duplicateReason: reason };
    } catch (err) {
      logger.error({ err, expenseId }, 'DuplicateDetectionService.runDuplicateCheck error');
      return { duplicateFlag: null, duplicateReason: null };
    }
  }

  /**
   * Run duplicate check for all expenses in a report. Updates each expense; never throws.
   */
  static async runReportDuplicateCheck(
    reportId: string,
    companyId?: mongoose.Types.ObjectId
  ): Promise<DuplicateCheckResult[]> {
    const expenses = await Expense.find({ reportId }).select('_id').exec();
    const results: DuplicateCheckResult[] = [];
    for (const e of expenses) {
      const r = await this.runDuplicateCheck((e._id as mongoose.Types.ObjectId).toString(), companyId);
      results.push(r);
    }
    return results;
  }
}

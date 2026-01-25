/**
 * Duplicate Detection Service (flag-only; never blocks submission)
 *
 * Primary data source priority: Receipt OCR / parsed invoice → parsed metadata → notes (fallback only).
 * Matching: vendor_name (normalized), amount (2 decimals), date (UTC ±1 day), invoice_id (optional).
 * Rules:
 * - Any 3 of { vendor, amount, date, invoice_id } match → POTENTIAL_DUPLICATE
 * - invoice_id match → STRONG_DUPLICATE
 * Stores duplicateFlag, duplicateReason on expense. Exposed to approver & company admin.
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
   * Run duplicate check for a single expense. Updates expense with duplicateFlag/duplicateReason.
   * Never throws; logs errors and returns result.
   */
  static async runDuplicateCheck(
    expenseId: string,
    companyId?: mongoose.Types.ObjectId
  ): Promise<DuplicateCheckResult> {
    try {
      const expense = await Expense.findById(expenseId)
        .select('userId vendor amount originalAmount expenseDate invoiceId invoiceDate notes reportId currency originalCurrency')
        .exec();
      if (!expense) {
        logger.warn({ expenseId }, 'DuplicateDetectionService: Expense not found');
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

      // Query should check both expenseDate and invoiceDate fields
      const baseQuery: Record<string, unknown> = {
        _id: { $ne: new mongoose.Types.ObjectId(expenseId) },
        status: { $ne: 'DRAFT' },
        $or: [
          { expenseDate: { $gte: start, $lt: end } },
          { invoiceDate: { $gte: start, $lt: end } },
        ],
      };

      if (companyId) {
        const companyUsers = await User.find({ companyId }).select('_id').exec();
        const userIds = companyUsers.map((u) => u._id);
        (baseQuery as any).userId = { $in: userIds };
      } else {
        (baseQuery as any).userId = expense.userId;
      }

      const candidates = await Expense.find(baseQuery as any)
        .select('_id vendor amount originalAmount expenseDate invoiceDate invoiceId currency originalCurrency')
        .exec();

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
        await Expense.findByIdAndUpdate(expenseId, { duplicateFlag: flag, duplicateReason: reason }).exec();
        logger.info({ expenseId, flag, reason }, 'DuplicateDetectionService: Duplicate detected');
      } else {
        await Expense.findByIdAndUpdate(expenseId, { $unset: { duplicateFlag: '', duplicateReason: '' } }).exec();
        logger.debug({ expenseId }, 'DuplicateDetectionService: No duplicate found');
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

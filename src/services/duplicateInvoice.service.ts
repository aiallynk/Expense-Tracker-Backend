import { createHash } from 'crypto';

import mongoose from 'mongoose';

import { Expense } from '../models/Expense';


import { logger } from '@/config/logger';

/**
 * Duplicate Invoice Detection Service
 * Detects duplicate invoices based on:
 * - Invoice ID
 * - Vendor Name
 * - Invoice Date
 * - Invoice Amount
 */
export class DuplicateInvoiceService {
  private static normalizeInvoiceId(invoiceId: string): string {
    return String(invoiceId || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  private static normalizeVendor(vendor: string): string {
    // Keep letters/numbers, collapse everything else to spaces for stability across punctuation variants.
    const cleaned = String(vendor || '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned;
  }

  private static toDateOnlyString(d: Date): string {
    const dt = new Date(d);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private static amountToMinorUnits(amount: number): number {
    // Normalize to 2 decimals (paise/cents). Avoid float drift via rounding.
    return Math.round(Number(amount) * 100);
  }

  static computeFingerprint(invoiceId: string, vendor: string, invoiceDate: Date, amount: number): string {
    const invoiceIdNorm = this.normalizeInvoiceId(invoiceId);
    const vendorNorm = this.normalizeVendor(vendor);
    const dateStr = this.toDateOnlyString(invoiceDate);
    const amountMinor = this.amountToMinorUnits(amount);
    const raw = `${invoiceIdNorm}|${vendorNorm}|${dateStr}|${amountMinor}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  private static escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private static dayBoundsUtc(date: Date): { start: Date; end: Date } {
    const dt = new Date(date);
    const start = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 0, 0, 0, 0));
    const end = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() + 1, 0, 0, 0, 0));
    return { start, end };
  }

  /**
   * Check if an invoice is a duplicate
   * @param invoiceId - Invoice ID/number
   * @param vendor - Vendor name
   * @param invoiceDate - Invoice date
   * @param amount - Invoice amount
   * @param excludeExpenseId - Expense ID to exclude from check (for updates)
   * @param companyId - Company ID to scope the check
   * @returns Object with isDuplicate flag and duplicate expense details if found
   */
  static async checkDuplicate(
    invoiceId: string,
    vendor: string,
    invoiceDate: Date,
    amount: number,
    excludeExpenseId?: string,
    companyId?: mongoose.Types.ObjectId
  ): Promise<{
    isDuplicate: boolean;
    duplicateExpense?: any;
    message?: string;
  }> {
    if (!invoiceId || !vendor || !invoiceDate || amount === undefined) {
      // If required fields are missing, skip duplicate check
      return { isDuplicate: false };
    }

    try {
      const fingerprint = this.computeFingerprint(invoiceId, vendor, invoiceDate, amount);
      const { start, end } = this.dayBoundsUtc(invoiceDate);

      const baseQuery: any = {};

      // Exclude current expense if updating
      if (excludeExpenseId) {
        baseQuery._id = { $ne: new mongoose.Types.ObjectId(excludeExpenseId) };
      }

      // If companyId is provided, scope to expenses from that company's users
      if (companyId) {
        const { User } = await import('../models/User');
        const companyUsers = await User.find({ companyId }).select('_id').exec();
        const userIds = companyUsers.map(u => u._id);
        baseQuery.userId = { $in: userIds };
      }

      // Prefer fingerprint match (fast path). Also include a legacy-safe match for older rows
      // that may not yet have invoiceFingerprint populated.
      const legacyInvoiceId = invoiceId.trim();
      const legacyVendor = vendor.trim();
      const legacyQuery: any = {
        invoiceId: { $regex: new RegExp(`^${this.escapeRegex(legacyInvoiceId)}$`, 'i') },
        vendor: { $regex: new RegExp(`^${this.escapeRegex(legacyVendor)}$`, 'i') },
        invoiceDate: { $gte: start, $lt: end },
        amount,
      };

      const query: any = {
        ...baseQuery,
        $or: [
          { invoiceFingerprint: fingerprint },
          legacyQuery,
        ],
      };

      const duplicateExpense = await Expense.findOne(query)
        .populate('userId', 'name email')
        .populate('reportId', 'name status')
        .sort({ createdAt: -1 })
        .exec();

      if (duplicateExpense) {
        const report = duplicateExpense.reportId as any;
        const user = duplicateExpense.userId as any;
        const expenseId = (duplicateExpense._id as mongoose.Types.ObjectId).toString();

        return {
          isDuplicate: true,
          duplicateExpense: {
            expenseId,
            reportId: report?._id?.toString(),
            reportName: report?.name,
            reportStatus: report?.status,
            userName: user?.name || user?.email,
            expenseDate: duplicateExpense.expenseDate,
          },
          message: `Duplicate invoice detected. This invoice (ID: ${invoiceId}) already exists in report "${report?.name || 'N/A'}" (status: ${report?.status || 'N/A'}) for ${user?.name || user?.email || 'N/A'}.`,
        };
      }

      return { isDuplicate: false };
    } catch (error) {
      logger.error({ error, invoiceId, vendor, invoiceDate, amount }, 'Error checking duplicate invoice');
      // Don't block on error - log and continue
      return { isDuplicate: false };
    }
  }

  /**
   * Check for duplicates when submitting a report
   * @param reportId - Report ID
   * @param companyId - Company ID
   * @returns Array of duplicate expenses found
   */
  static async checkReportDuplicates(
    reportId: string,
    companyId?: mongoose.Types.ObjectId
  ): Promise<Array<{ expenseId: string; message: string }>> {
    const expenses = await Expense.find({ reportId })
      .select('invoiceId vendor invoiceDate amount _id')
      .exec();

    const duplicates: Array<{ expenseId: string; message: string }> = [];

    for (const expense of expenses) {
      if (expense.invoiceId && expense.vendor && expense.invoiceDate && expense.amount) {
        const expenseId = (expense._id as mongoose.Types.ObjectId).toString();
        const check = await this.checkDuplicate(
          expense.invoiceId,
          expense.vendor,
          expense.invoiceDate,
          expense.amount,
          expenseId,
          companyId
        );

        if (check.isDuplicate && check.message) {
          duplicates.push({
            expenseId,
            message: check.message,
          });
        }
      }
    }

    return duplicates;
  }
}


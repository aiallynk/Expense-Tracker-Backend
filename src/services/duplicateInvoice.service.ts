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
      // Build query to find duplicates
      const query: any = {
        invoiceId: invoiceId.trim(),
        vendor: vendor.trim(),
        invoiceDate: new Date(invoiceDate),
        amount: amount,
      };

      // Exclude current expense if updating
      if (excludeExpenseId) {
        query._id = { $ne: new mongoose.Types.ObjectId(excludeExpenseId) };
      }

      // If companyId is provided, scope to expenses from that company's users
      if (companyId) {
        const { User } = await import('../models/User');
        const companyUsers = await User.find({ companyId }).select('_id').exec();
        const userIds = companyUsers.map(u => u._id);
        query.userId = { $in: userIds };
      }

      // Find duplicate expense
      const duplicateExpense = await Expense.findOne(query)
        .populate('userId', 'name email')
        .populate('reportId', 'name status')
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
          message: `Duplicate invoice detected. This invoice (ID: ${invoiceId}) was already submitted in report "${report?.name || 'N/A'}" by ${user?.name || user?.email || 'N/A'}.`,
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


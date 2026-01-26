/**
 * Receipt Duplicate Detection Service
 * 
 * Company-wide receipt-level duplicate detection.
 * Checks for duplicate receipt images using perceptual/average hashes and OCR text hashes.
 * 
 * CRITICAL: Data isolation - never exposes other users' expense data.
 * Only returns match type (IMAGE_PERCEPTUAL, IMAGE_AVERAGE, OCR_TEXT).
 */

import mongoose from 'mongoose';

import { Receipt } from '../models/Receipt';
import { Expense } from '../models/Expense';
import { ExpenseReportStatus } from '../utils/enums';

import { logger } from '@/config/logger';

export type ReceiptDuplicateMatchType = 'IMAGE_PERCEPTUAL' | 'IMAGE_AVERAGE' | 'OCR_TEXT';

export interface ReceiptDuplicateCheckResult {
  isDuplicate: boolean;
  matchType?: ReceiptDuplicateMatchType;
  reason?: string;
}

export class ReceiptDuplicateDetectionService {
  /**
   * Check if a receipt is a duplicate within the same company
   * 
   * @param receiptId - The receipt ID to check
   * @param companyId - Company ID for scoping the check
   * @returns Duplicate check result with match type (no user data exposed)
   */
  static async checkReceiptDuplicate(
    receiptId: string,
    companyId: mongoose.Types.ObjectId
  ): Promise<ReceiptDuplicateCheckResult> {
    try {
      const receipt = await Receipt.findById(receiptId)
        .select('imagePerceptualHash imageAverageHash ocrTextHash companyId')
        .exec();

      if (!receipt) {
        logger.warn({ receiptId }, 'ReceiptDuplicateDetectionService: Receipt not found');
        return { isDuplicate: false };
      }

      // Ensure companyId matches
      if (!receipt.companyId || receipt.companyId.toString() !== companyId.toString()) {
        logger.warn({ receiptId, receiptCompanyId: receipt.companyId, providedCompanyId: companyId }, 
          'ReceiptDuplicateDetectionService: Company ID mismatch');
        return { isDuplicate: false };
      }

      // Build query for matching hashes within company
      const hashConditions: any[] = [];
      
      if (receipt.imagePerceptualHash) {
        hashConditions.push({ imagePerceptualHash: receipt.imagePerceptualHash });
      }
      if (receipt.imageAverageHash) {
        hashConditions.push({ imageAverageHash: receipt.imageAverageHash });
      }
      if (receipt.ocrTextHash) {
        hashConditions.push({ ocrTextHash: receipt.ocrTextHash });
      }

      if (hashConditions.length === 0) {
        // No hashes available yet, cannot check for duplicates
        return { isDuplicate: false };
      }

      // Use aggregation pipeline to exclude receipts from rejected expenses
      // This ensures we don't consider rejected expenses as duplicates
      const duplicateReceipts = await Receipt.aggregate([
        // Match receipts with same hashes in same company (excluding current receipt)
        {
          $match: {
            _id: { $ne: new mongoose.Types.ObjectId(receiptId) },
            companyId: companyId,
            $or: hashConditions,
          },
        },
        // Lookup expense to check status
        {
          $lookup: {
            from: 'expenses',
            localField: 'expenseId',
            foreignField: '_id',
            as: 'expense',
          },
        },
        // Unwind expense array (should be 0 or 1)
        {
          $unwind: {
            path: '$expense',
            preserveNullAndEmptyArrays: true,
          },
        },
        // Lookup report to check status
        {
          $lookup: {
            from: 'expensereports',
            localField: 'expense.reportId',
            foreignField: '_id',
            as: 'report',
          },
        },
        // Unwind report array
        {
          $unwind: {
            path: '$report',
            preserveNullAndEmptyArrays: true,
          },
        },
        // Filter out receipts from rejected expenses/reports
        {
          $match: {
            $or: [
              // Receipt has no expense (standalone)
              { expense: { $exists: false } },
              // Expense exists but is not rejected
              { 'expense.status': { $ne: 'REJECTED' } },
              // Report exists and is not rejected
              { 'report.status': { $ne: ExpenseReportStatus.REJECTED } },
            ],
          },
        },
        // Project only what we need (no user data)
        {
          $project: {
            _id: 1,
            imagePerceptualHash: 1,
            imageAverageHash: 1,
            ocrTextHash: 1,
          },
        },
        // Limit to 1 (we only need to know if duplicate exists)
        {
          $limit: 1,
        },
      ]).exec();

      if (duplicateReceipts.length === 0) {
        return { isDuplicate: false };
      }

      const duplicate = duplicateReceipts[0];
      
      // Determine match type
      let matchType: ReceiptDuplicateMatchType;
      let reason: string;

      if (receipt.imagePerceptualHash && duplicate.imagePerceptualHash === receipt.imagePerceptualHash) {
        matchType = 'IMAGE_PERCEPTUAL';
        reason = 'Same receipt image (perceptual match)';
      } else if (receipt.imageAverageHash && duplicate.imageAverageHash === receipt.imageAverageHash) {
        matchType = 'IMAGE_AVERAGE';
        reason = 'Same receipt image (exact/near-exact match)';
      } else if (receipt.ocrTextHash && duplicate.ocrTextHash === receipt.ocrTextHash) {
        matchType = 'OCR_TEXT';
        reason = 'Same receipt content (OCR text match)';
      } else {
        // Fallback (shouldn't happen, but handle gracefully)
        matchType = 'IMAGE_AVERAGE';
        reason = 'Duplicate receipt detected';
      }

      logger.info({ receiptId, matchType, reason }, 'ReceiptDuplicateDetectionService: Duplicate receipt detected');

      return {
        isDuplicate: true,
        matchType,
        reason,
      };
    } catch (error: any) {
      logger.error({ error: error.message, receiptId }, 'ReceiptDuplicateDetectionService: Error checking duplicate');
      // Don't block on error - return no duplicate
      return { isDuplicate: false };
    }
  }

  /**
   * Release receipt hashes when expense/report is rejected
   * This allows the receipt to be reused for legitimate resubmissions
   * 
   * @param expenseId - The expense ID whose receipt hashes should be released
   */
  static async releaseReceiptHashes(expenseId: string): Promise<void> {
    try {
      const expense = await Expense.findById(expenseId)
        .select('status receiptIds')
        .exec();

      if (!expense) {
        logger.warn({ expenseId }, 'ReceiptDuplicateDetectionService: Expense not found for hash release');
        return;
      }

      // Only release if expense is actually rejected
      if (expense.status !== 'REJECTED') {
        logger.debug({ expenseId, status: expense.status }, 
          'ReceiptDuplicateDetectionService: Expense not rejected, skipping hash release');
        return;
      }

      // Clear hashes from all receipts linked to this expense
      if (expense.receiptIds && expense.receiptIds.length > 0) {
        await Receipt.updateMany(
          { _id: { $in: expense.receiptIds } },
          {
            $unset: {
              imagePerceptualHash: '',
              imageAverageHash: '',
              ocrTextHash: '',
            },
          }
        ).exec();

        logger.info({ expenseId, receiptCount: expense.receiptIds.length }, 
          'ReceiptDuplicateDetectionService: Released receipt hashes for rejected expense');
      }
    } catch (error: any) {
      logger.error({ error: error.message, expenseId }, 
        'ReceiptDuplicateDetectionService: Error releasing receipt hashes');
      // Don't throw - hash release is non-critical
    }
  }

  /**
   * Release receipt hashes for all expenses in a rejected report
   * 
   * @param reportId - The report ID whose expenses' receipt hashes should be released
   */
  static async releaseReceiptHashesForReport(reportId: string): Promise<void> {
    try {
      const expenses = await Expense.find({ reportId })
        .select('_id status receiptIds')
        .exec();

      for (const expense of expenses) {
        if (expense.status === 'REJECTED' && expense.receiptIds && expense.receiptIds.length > 0) {
          await Receipt.updateMany(
            { _id: { $in: expense.receiptIds } },
            {
              $unset: {
                imagePerceptualHash: '',
                imageAverageHash: '',
                ocrTextHash: '',
              },
            }
          ).exec();
        }
      }

      logger.info({ reportId, expenseCount: expenses.length }, 
        'ReceiptDuplicateDetectionService: Released receipt hashes for rejected report');
    } catch (error: any) {
      logger.error({ error: error.message, reportId }, 
        'ReceiptDuplicateDetectionService: Error releasing receipt hashes for report');
      // Don't throw - hash release is non-critical
    }
  }
}

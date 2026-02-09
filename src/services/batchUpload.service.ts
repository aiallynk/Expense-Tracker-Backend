/**
 * Batch-first receipt upload: create all receipts and expense drafts first,
 * enqueue all OCR jobs immediately, respond once. OCR runs in parallel (BLAST when batch).
 */

import { randomUUID } from 'crypto';
import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { Receipt } from '../models/Receipt';
import { Batch } from '../models/Batch';
import { Category } from '../models/Category';
import { User } from '../models/User';
import { ReceiptStatus, BatchStatus } from '../utils/enums';
import { ExpenseStatus, ExpenseSource } from '../utils/enums';
import { getPresignedUploadUrl, getObjectUrl } from '../utils/s3';
import { OcrService } from './ocr.service';
import { ReportsService } from './reports.service';
import { ReceiptHashService } from './receiptHash.service';
import { ReceiptDuplicateDetectionService } from './receiptDuplicateDetection.service';

import { logger } from '@/config/logger';

export interface BatchIntentFile {
  filename?: string;
  mimeType: string;
  sizeBytes?: number;
}

export interface BatchIntentResult {
  batchId: string;
  receipts: Array<{ receiptId: string; uploadUrl: string; storageKey: string }>;
}

export interface BatchConfirmReceipt {
  receiptId: string;
  storageKey: string;
  mimeType: string;
}

export interface BatchConfirmResult {
  batchId: string;
  receiptIds: string[];
  expenseIds: string[];
  ocrJobIds: string[];
}

export class BatchUploadService {
  /**
   * Create upload intents for a batch of receipt images. Saves all receipts with batchId; returns presigned URLs.
   * One API call for the entire batch.
   */
  static async createBatchIntent(
    reportId: string,
    userId: string,
    batchId: string,
    files: BatchIntentFile[]
  ): Promise<BatchIntentResult> {
    const report = await ExpenseReport.findById(reportId);
    if (!report) throw new Error('Report not found');
    if (report.userId.toString() !== userId) throw new Error('Access denied');
    if (report.status !== 'DRAFT' && report.status !== 'CHANGES_REQUESTED') {
      throw new Error('Can only add receipts to draft reports or reports with changes requested');
    }

    const receipts: Array<{ receiptId: string; uploadUrl: string; storageKey: string }> = [];
    const receiptObjectIds: mongoose.Types.ObjectId[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const storageKey = `bulk-uploads/${reportId}/${batchId}/${randomUUID()}-${Date.now()}-${i}`;
      const uploadUrl = await getPresignedUploadUrl({
        bucketType: 'receipts',
        key: storageKey,
        mimeType: file.mimeType,
        expiresIn: 3600,
      });
      const storageUrl = getObjectUrl('receipts', storageKey);

      const receipt = new Receipt({
        storageKey,
        storageUrl,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes ?? 0,
        uploadConfirmed: false,
        batchId,
        parsedData: { batchId, reportId, isBatchReceipt: true },
      });
      const saved = await receipt.save();
      receiptObjectIds.push(saved._id as mongoose.Types.ObjectId);
      receipts.push({
        receiptId: (saved._id as mongoose.Types.ObjectId).toString(),
        uploadUrl,
        storageKey,
      });
    }

    const reportDoc = await ExpenseReport.findById(reportId).select('userId').exec();
    const batch = new Batch({
      batchId,
      reportId: new mongoose.Types.ObjectId(reportId),
      userId: reportDoc?.userId ?? new mongoose.Types.ObjectId(userId),
      totalReceipts: files.length,
      completedReceipts: 0,
      failedReceipts: 0,
      status: BatchStatus.UPLOADING,
      receiptIds: receiptObjectIds,
      expenseIds: [],
      ocrJobIds: [],
    });
    await batch.save();

    logger.info({ batchId, reportId, count: receipts.length }, 'Batch upload intent created');
    return { batchId, receipts };
  }

  /**
   * Confirm batch: for each receipt create expense draft, link receipt, set companyId and uploadConfirmed,
   * enqueue OCR job (with batchId so queue can use BLAST). Return once with all IDs. Do NOT wait for OCR.
   */
  static async confirmBatch(
    reportId: string,
    userId: string,
    batchId: string,
    receiptsInput: BatchConfirmReceipt[]
  ): Promise<BatchConfirmResult> {
    const report = await ExpenseReport.findById(reportId).select('fromDate toDate userId');
    if (!report) throw new Error('Report not found');
    if (report.userId.toString() !== userId) throw new Error('Access denied');

    const user = await User.findById(userId).select('companyId').exec();
    const companyId = user?.companyId as mongoose.Types.ObjectId | undefined;

    const defaultCategory = await Category.findOne({ name: { $regex: /^(Other|Others|Miscellaneous|Misc|General)$/i } }).exec()
      || await Category.findOne({}).exec();
    const categoryId = defaultCategory?._id as mongoose.Types.ObjectId | undefined;

    const receiptIds: string[] = [];
    const expenseIds: string[] = [];
    const ocrJobIds: string[] = [];
    const batchSize = receiptsInput.length;

    for (const item of receiptsInput) {
      const receipt = await Receipt.findById(item.receiptId);
      if (!receipt) {
        logger.error({ receiptId: item.receiptId }, 'Batch confirm: receipt not found');
        throw new Error(`Receipt not found: ${item.receiptId}. Please retry the upload.`);
      }
      if (receipt.batchId !== batchId) {
        logger.error({ receiptId: item.receiptId, batchId }, 'Batch confirm: batchId mismatch');
        throw new Error(`Batch mismatch for receipt ${item.receiptId}. Please retry the upload.`);
      }
      if (receipt.uploadConfirmed) {
        logger.debug({ receiptId: item.receiptId }, 'Batch confirm: already confirmed');
        receiptIds.push(item.receiptId);
        if (receipt.expenseId) expenseIds.push((receipt.expenseId as mongoose.Types.ObjectId).toString());
        if (receipt.ocrJobId) ocrJobIds.push((receipt.ocrJobId as mongoose.Types.ObjectId).toString());
        continue;
      }

      // Receipt fingerprint is identity: generate image hashes and check duplicate BEFORE creating expense
      let isDuplicateReceipt = false;
      if (companyId) {
        receipt.companyId = companyId;
        await receipt.save();

        const imageHashes = await ReceiptHashService.generateHashesForReceipt(receipt.storageKey, receipt.mimeType);
        if (imageHashes) {
          receipt.imagePerceptualHash = imageHashes.perceptualHash;
          receipt.imageAverageHash = imageHashes.averageHash;
          await receipt.save();

          const dupCheck = await ReceiptDuplicateDetectionService.checkReceiptDuplicate(
            (receipt._id as mongoose.Types.ObjectId).toString(),
            companyId,
            { excludeBatchId: batchId }
          );
          if (dupCheck.isDuplicate) {
            isDuplicateReceipt = true;
            logger.info({ receiptId: item.receiptId, matchType: dupCheck.matchType, reason: dupCheck.reason }, 'Batch confirm: duplicate receipt detected — NOT creating expense');
          }
        }
      }

      // CRITICAL: Never create expense for duplicate receipts — they must never appear on report
      if (isDuplicateReceipt) {
        receipt.uploadConfirmed = true;
        receipt.status = ReceiptStatus.COMPLETED; // Mark as done so batch progress completes
        if (companyId) receipt.companyId = companyId;
        await receipt.save();
        receiptIds.push((receipt._id as mongoose.Types.ObjectId).toString());
        expenseIds.push(''); // No expense — frontend will show "Duplicate (skipped)"
        ocrJobIds.push(''); // No OCR job
        continue;
      }

      const expense = new Expense({
        reportId: new mongoose.Types.ObjectId(reportId),
        userId: report.userId,
        vendor: 'Processing...',
        categoryId,
        amount: 0,
        currency: 'INR',
        expenseDate: report.fromDate,
        status: ExpenseStatus.DRAFT,
        source: ExpenseSource.SCANNED,
        receiptIds: [receipt._id as mongoose.Types.ObjectId],
        receiptPrimaryId: receipt._id as mongoose.Types.ObjectId,
      });
      const savedExpense = await expense.save();

      receipt.expenseId = savedExpense._id as mongoose.Types.ObjectId;
      receipt.uploadConfirmed = true;
      receipt.status = ReceiptStatus.PROCESSING;
      if (companyId) receipt.companyId = companyId;
      await receipt.save();

      receiptIds.push((receipt._id as mongoose.Types.ObjectId).toString());
      expenseIds.push((savedExpense._id as mongoose.Types.ObjectId).toString());

      try {
        let jobId = await OcrService.enqueueOcrJob(item.receiptId, { batchId, batchSize });
        ocrJobIds.push(jobId);
      } catch (err: any) {
        logger.warn({ receiptId: item.receiptId, error: err.message }, 'Batch confirm: failed to enqueue OCR, retrying once');
        try {
          await new Promise((r) => setTimeout(r, 500));
          const jobId = await OcrService.enqueueOcrJob(item.receiptId, { batchId, batchSize });
          ocrJobIds.push(jobId);
        } catch (retryErr: any) {
          logger.error({ receiptId: item.receiptId, error: retryErr.message }, 'Batch confirm: OCR enqueue failed after retry');
          throw new Error(`Failed to queue OCR for receipt ${item.receiptId}. Please retry the upload.`);
        }
      }
    }

    await ReportsService.recalcTotals(reportId);

    const batch = await Batch.findOne({ batchId }).exec();
    if (batch) {
      batch.status = BatchStatus.PROCESSING;
      batch.expenseIds = expenseIds.filter(Boolean).map((id) => new mongoose.Types.ObjectId(id));
      batch.ocrJobIds = ocrJobIds.filter(Boolean);
      await batch.save();
    }

    logger.info({ batchId, reportId, receiptCount: receiptIds.length, ocrJobCount: ocrJobIds.length }, 'Batch confirm completed');
    return { batchId, receiptIds, expenseIds, ocrJobIds };
  }

  /**
   * Get batch status by batchId. User must own the batch (userId matches).
   */
  static async getBatchStatus(batchId: string, userId: string): Promise<{
    batchId: string;
    totalReceipts: number;
    completedReceipts: number;
    failedReceipts: number;
    status: string;
  } | null> {
    const batch = await Batch.findOne({ batchId }).exec();
    if (!batch) return null;
    if (batch.userId.toString() !== userId) return null;

    // Reconcile progress from Receipt statuses to avoid stuck UI when:
    // - confirmBatch is called more than once (some receipts already confirmed/processed)
    // - socket events are missed
    // - counters were not incremented due to transient issues
    try {
      const receiptObjectIds = (batch.receiptIds || []).filter(Boolean) as mongoose.Types.ObjectId[];
      if (receiptObjectIds.length > 0) {
        const receipts = await Receipt.find({ _id: { $in: receiptObjectIds } })
          .select('_id status uploadConfirmed')
          .lean()
          .exec();

        const completed = receipts.filter((r: any) => r.status === ReceiptStatus.COMPLETED).length;
        const failed = receipts.filter((r: any) => r.status === ReceiptStatus.FAILED).length;
        const total = batch.totalReceipts ?? receiptObjectIds.length;

        const anyDiff =
          (batch.completedReceipts ?? 0) !== completed ||
          (batch.failedReceipts ?? 0) !== failed;

        if (anyDiff) {
          batch.completedReceipts = completed;
          batch.failedReceipts = failed;
        }

        // Derive batch status deterministically from receipts + totals.
        // - If all receipts are confirmed and at least one is still processing, keep PROCESSING
        // - If completed+failed reaches total, finalize to COMPLETED/PARTIAL
        const allUploadConfirmed = receipts.length > 0 && receipts.every((r: any) => r.uploadConfirmed === true);
        if (completed + failed >= total) {
          batch.status = failed > 0 ? BatchStatus.PARTIAL : BatchStatus.COMPLETED;
        } else if (allUploadConfirmed) {
          batch.status = BatchStatus.PROCESSING;
        } else {
          batch.status = BatchStatus.UPLOADING;
        }

        if (anyDiff) {
          await batch.save();
        }
      }
    } catch (err: any) {
      // Non-blocking: return stored status even if reconciliation fails
      logger.warn({ error: err?.message, batchId }, 'Batch status reconciliation failed (non-blocking)');
    }

    return {
      batchId: batch.batchId,
      totalReceipts: batch.totalReceipts,
      completedReceipts: batch.completedReceipts ?? 0,
      failedReceipts: batch.failedReceipts ?? 0,
      status: batch.status,
    };
  }

  /**
   * Re-enqueue OCR for failed receipts in the batch only. User must own the batch.
   * Returns receipt IDs that were re-queued.
   */
  static async retryFailedReceipts(batchId: string, userId: string): Promise<{ receiptIds: string[]; enqueued: number }> {
    const batch = await Batch.findOne({ batchId }).exec();
    if (!batch) throw new Error('Batch not found');
    if (batch.userId.toString() !== userId) throw new Error('Access denied');

    const receiptIds: string[] = [];
    let enqueued = 0;
    for (const receiptId of batch.receiptIds ?? []) {
      const rid = (receiptId as mongoose.Types.ObjectId).toString();
      const receipt = await Receipt.findById(rid).exec();
      if (!receipt || receipt.batchId !== batchId) continue;
      const isFailed = receipt.status === ReceiptStatus.FAILED;
      if (!isFailed) continue;
      receiptIds.push(rid);
      try {
        await OcrService.enqueueOcrJob(rid, { batchId, batchSize: batch.totalReceipts });
        enqueued++;
        receipt.status = ReceiptStatus.PROCESSING;
        await receipt.save();
      } catch (err: any) {
        logger.warn({ receiptId: rid, error: err.message }, 'Batch retry: failed to enqueue OCR');
      }
    }
    if (enqueued > 0) {
      batch.failedReceipts = Math.max(0, (batch.failedReceipts ?? 0) - enqueued);
      batch.status = BatchStatus.PROCESSING;
      await batch.save();
    }
    return { receiptIds, enqueued };
  }
}

import { HeadObjectCommand } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';

import { getS3Bucket } from '../config/aws';
import { config } from '../config/index';
import { openaiClient, getVisionModel } from '../config/openai';
import { OcrJob, IOcrJob } from '../models/OcrJob';
import { Receipt } from '../models/Receipt';
import { OcrJobStatus } from '../utils/enums';
import { ocrQueue } from '../utils/inProcessQueue';
import { getPresignedDownloadUrl } from '../utils/s3';

import { logger } from '@/config/logger';
import { ReceiptStatus, ReceiptFailureReason } from '../utils/enums';
import { emitReceiptProcessed, emitReceiptProcessing, ReceiptProcessedPayload, emitBatchProgress } from '../socket/realtimeEvents';
import { Batch } from '../models/Batch';
import { BatchStatus } from '../utils/enums';
import {
  buildFullReceiptText,
  inferCategoryFromReceiptText,
  extractNotesFromLineItems,
} from './ocr/ocrPostProcess.service';

/** Update Batch progress and emit batch:progress when a receipt completes (success or failure). */
async function updateBatchProgressAndEmit(userId: string, batchId: string, isSuccess: boolean): Promise<void> {
  try {
    const batch = await Batch.findOne({ batchId }).exec();
    if (!batch) return;
    if (isSuccess) {
      batch.completedReceipts = (batch.completedReceipts || 0) + 1;
    } else {
      batch.failedReceipts = (batch.failedReceipts || 0) + 1;
    }
    const completed = batch.completedReceipts || 0;
    const failed = batch.failedReceipts || 0;
    const total = batch.totalReceipts || 0;
    if (completed + failed >= total) {
      batch.status = failed > 0 ? BatchStatus.PARTIAL : BatchStatus.COMPLETED;
    }
    await batch.save();
    emitBatchProgress(userId, {
      batchId: batch.batchId,
      totalReceipts: total,
      completedReceipts: completed,
      failedReceipts: failed,
      status: batch.status as 'UPLOADING' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL',
    });
  } catch (err: any) {
    logger.warn({ error: err?.message, batchId }, 'OCR: Failed to update batch progress (non-blocking)');
  }
}
import { ReceiptHashService } from './receiptHash.service';
import { ReceiptDuplicateDetectionService } from './receiptDuplicateDetection.service';

export interface OcrResult {
  vendor?: string;
  date?: string;
  totalAmount?: number;
  currency?: string;
  tax?: number;
  lineItems?: Array<{ description: string; amount: number }>;
  notes?: string;
  confidence?: number;
  invoice_number?: string;
  invoiceId?: string;
  /** True if the receipt appears to be handwritten (so user should recheck). */
  isHandwritten?: boolean;
  /** Field names that are doubtful and should be highlighted for user review (e.g. "date", "vendor", "total"). */
  doubtfulFields?: string[];
  /** True if date format was ambiguous (e.g. 26-01-23) and user should confirm. */
  dateReviewRecommended?: boolean;
  /** Exchange rate if present on receipt (for multi-currency). */
  exchangeRate?: number | null;
}

export class OcrService {
  /**
   * Enqueue OCR job to in-process queue (non-blocking)
   * Returns job ID immediately.
   * When options.batchId and options.batchSize are set, queue may use BLAST mode for parallel processing.
   */
  static async enqueueOcrJob(
    receiptId: string,
    options?: { batchId?: string; batchSize?: number }
  ): Promise<string> {
    const receipt = await Receipt.findById(receiptId).populate({
      path: 'expenseId',
      populate: { path: 'reportId' },
    });

    if (!receipt) {
      throw new Error('Receipt not found');
    }

    // Extract userId from receipt (via expense → report → userId)
    let userId: string | undefined;
    if (receipt.expenseId) {
      const expense = receipt.expenseId as any;
      const report = expense.reportId as any;
      if (report && report.userId) {
        userId = report.userId.toString();
      }
    }

    // Check if OCR is disabled
    if (config.ocr.disableOcr) {
      const ocrJob = new OcrJob({
        status: OcrJobStatus.COMPLETED,
        provider: 'DISABLED',
        receiptId,
        result: { message: 'OCR disabled by configuration' },
        attempts: 0,
      });
      const saved = await ocrJob.save();
      receipt.ocrJobId = saved._id as mongoose.Types.ObjectId;
      await receipt.save();
      return (saved._id as mongoose.Types.ObjectId).toString();
    }

    // Create OCR job with QUEUED status
    const ocrJob = new OcrJob({
      status: OcrJobStatus.QUEUED,
      provider: 'OPENAI',
      receiptId,
      attempts: 0,
    });

    const saved = await ocrJob.save();
    receipt.ocrJobId = saved._id as mongoose.Types.ObjectId;
    await receipt.save();

    const jobId = (saved._id as mongoose.Types.ObjectId).toString();

    // Enqueue job to p-queue (non-blocking, processes automatically)
    try {
      const queueResult = await ocrQueue.add(
        {
          jobId,
          receiptId,
          userId,
          createdAt: new Date(),
          batchId: options?.batchId,
          batchSize: options?.batchSize,
        },
        async (job) => {
          // Processor function - called by p-queue when job is ready
          await OcrService.processOcrJob(job.jobId);
        }
      );

      // If job is queued (per-user limit exceeded), emit socket event
      if (queueResult.queued && userId && queueResult.position) {
        // Emit queued event to frontend
        const { emitReceiptQueued } = await import('../socket/realtimeEvents');
        emitReceiptQueued(userId, receiptId, queueResult.position);
      }
    } catch (error: any) {
      // If queue is full or timeout, mark job as failed
      ocrJob.status = OcrJobStatus.FAILED;
      ocrJob.error = error.message || 'Queue error';
      await ocrJob.save();
      throw error;
    }

    return jobId;
  }

  /**
   * Process OCR synchronously (no queue) - DEPRECATED, kept for backward compatibility
   * Use enqueueOcrJob instead
   */
  static async processReceiptSync(receiptId: string): Promise<IOcrJob> {
    const receipt = await Receipt.findById(receiptId);

    if (!receipt) {
      throw new Error('Receipt not found');
    }

    // Check if OCR is disabled
    if (config.ocr.disableOcr) {
      const ocrJob = new OcrJob({
        status: OcrJobStatus.COMPLETED,
        provider: 'DISABLED',
        receiptId,
        result: { message: 'OCR disabled by configuration' },
        attempts: 0,
      });
      const saved = await ocrJob.save();
      receipt.ocrJobId = saved._id as mongoose.Types.ObjectId;
      await receipt.save();
      return saved;
    }

    // Create OCR job
    const ocrJob = new OcrJob({
      status: OcrJobStatus.PROCESSING,
      provider: 'OPENAI',
      receiptId,
      attempts: 0,
    });

    const saved = await ocrJob.save();
    receipt.ocrJobId = saved._id as mongoose.Types.ObjectId;
    await receipt.save();

    // Process immediately (synchronously)
    try {
      return await this.processOcrJob((saved._id as any).toString());
    } catch (error: any) {
      logger.error({
        jobId: saved._id,
        receiptId,
        error: error.message,
      }, 'OCR processing failed');
      throw error;
    }
  }

  /**
   * Mark OCR jobs stuck in PROCESSING (older than 2x timeout) as FAILED and emit.
   * Ensures every job eventually resolves to COMPLETED or FAILED.
   */
  static async markStuckOcrJobsAsFailed(): Promise<void> {
    const timeoutMs = (config.ocr as any).timeoutMs ?? 30000;
    const cutoff = new Date(Date.now() - timeoutMs * 2);
    const stuck = await OcrJob.find({
      status: OcrJobStatus.PROCESSING,
      $or: [
        { startedAt: { $exists: true, $ne: null, $lt: cutoff } },
        { updatedAt: { $lt: cutoff } },
      ],
    }).exec();
    for (const j of stuck) {
      try {
        j.status = OcrJobStatus.FAILED;
        j.error = 'Stuck (timeout)';
        j.errorJson = { message: 'Stuck (timeout)' };
        await j.save();
        const receipt = await Receipt.findById(j.receiptId).populate({
          path: 'expenseId',
          populate: { path: 'reportId' },
        }).exec();
        if (receipt) {
          (receipt as any).status = ReceiptStatus.FAILED;
          (receipt as any).failureReason = ReceiptFailureReason.TIMEOUT;
          await receipt.save();
          const receiptIdStr = (receipt._id as mongoose.Types.ObjectId).toString();
          let userId: string | null = null;
          if ((receipt as any).expenseId) {
            const report = (receipt as any).expenseId.reportId;
            if (report?.userId) userId = report.userId.toString();
          }
          if (userId) {
            emitReceiptProcessed(userId, receiptIdStr, {
              receiptId: receiptIdStr,
              status: 'FAILED',
              reason: ReceiptFailureReason.TIMEOUT,
              batchId: (receipt as any).batchId ?? undefined,
            });
            if ((receipt as any).batchId) {
              await updateBatchProgressAndEmit(userId, (receipt as any).batchId, false);
            }
          }
        }
        logger.warn({ jobId: j._id, receiptId: j.receiptId }, 'OCR: Marked stuck job as FAILED');
      } catch (err: any) {
        logger.warn({ error: err?.message, jobId: j._id }, 'OCR: Failed to mark stuck job (non-blocking)');
      }
    }
  }

  static async processOcrJob(jobId: string): Promise<IOcrJob> {
    const job = await OcrJob.findById(jobId).populate('receiptId');

    if (!job) {
      throw new Error('OCR job not found');
    }

    await OcrService.markStuckOcrJobsAsFailed();

    const ocrStartTime = Date.now();
    job.status = OcrJobStatus.PROCESSING;
    job.startedAt = new Date();
    await job.save();

    // Get receipt populated data from job (declared early for use throughout function)
    const receiptPopulated = job.receiptId as any;

    // Get receipt and update status to PROCESSING
    const receiptDoc = await Receipt.findById(job.receiptId).populate({
      path: 'expenseId',
      populate: { path: 'reportId' },
    });

    let userId: string | null = null;
    let receiptIdStr: string | null = null;

    if (receiptDoc) {
      receiptDoc.status = ReceiptStatus.PROCESSING;
      await receiptDoc.save();

      receiptIdStr = (receiptDoc._id as mongoose.Types.ObjectId).toString();

      // Minimal log: OCR_STARTED
      logger.info({ receiptId: receiptIdStr }, 'OCR_STARTED');

      // Get userId for socket emission
      if (receiptDoc.expenseId) {
        const expense = receiptDoc.expenseId as any;
        const report = expense.reportId as any;
        if (report && report.userId) {
          userId = report.userId.toString();
        }
      }

      // Emit processing event when OCR job starts
      if (userId && receiptIdStr) {
        emitReceiptProcessing(userId, receiptIdStr);
      }
    } else {
      // Fallback: get receiptId from populated job
      receiptIdStr = receiptPopulated?._id?.toString() || job.receiptId?.toString() || '';
      logger.info({ receiptId: receiptIdStr }, 'OCR_STARTED');
    }

    try {

      if (!receiptPopulated) {
        throw new Error('Receipt not found for OCR job');
      }

      const bucket = getS3Bucket('receipts');

      // Verify the object exists in S3 (lightweight check)
      try {
        const { s3Client } = await import('../config/aws');
        const headCommand = new HeadObjectCommand({
          Bucket: bucket,
          Key: receiptPopulated.storageKey,
        });
        await s3Client.send(headCommand);
      } catch (headError: any) {
        if (headError.name === 'NotFound' || headError.$metadata?.httpStatusCode === 404) {
          job.status = OcrJobStatus.FAILED;
          job.error = 'Receipt file not found in S3. Please ensure the upload completed successfully.';
          await job.save();
          throw new Error('Receipt file not found in S3');
        }
        throw headError;
      }

      // Generate presigned GET URL (5 min expiry) for OpenAI to access image directly
      const presignedUrl = await getPresignedDownloadUrl('receipts', receiptPopulated.storageKey, 300);

      // Track OpenAI API call time
      const openaiStartTime = Date.now();

      // Call OpenAI Vision API with retry and exponential backoff for transient failures
      const maxAttempts = (config.ocr as any).retryMaxAttempts ?? 3;
      const backoffBaseMs = (config.ocr as any).retryBackoffBaseMs ?? 1000;
      let ocrResult: OcrResult;
      let tokenUsage: { total_tokens: number } | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const response = await this.callOpenAIVisionWithTimeout(
            presignedUrl,
            receiptPopulated.mimeType,
            config.ocr.timeoutMs
          );
          ocrResult = response.result;
          tokenUsage = response.usage;
          break;
        } catch (err: any) {
          const isRetryable =
            err.status === 429 ||
            (err.status >= 500 && err.status < 600) ||
            err.message?.includes('timeout') ||
            err.message?.includes('timed out');
          const isNonRetryable =
            err.status === 401 ||
            err.message?.includes('authentication') ||
            err.message?.includes('Unauthorized') ||
            err.message?.includes('invalid_model');

          if (isNonRetryable || !isRetryable || attempt >= maxAttempts) {
            throw err;
          }
          const delayMs = backoffBaseMs * Math.pow(2, attempt - 1);
          logger.warn(
            { receiptId: receiptIdStr, attempt, maxAttempts, delayMs, error: err.message },
            'OCR transient error, retrying with backoff'
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      const result = ocrResult!;

      const openaiTimeMs = Date.now() - openaiStartTime;

      const totalProcessingTimeMs = Date.now() - ocrStartTime;

      // Calculate queue wait time (from job creation to processing start)
      let queueWaitTimeMs = 0;
      if (job.createdAt) {
        const createdAtTime = job.createdAt instanceof Date
          ? job.createdAt.getTime()
          : new Date(job.createdAt).getTime();
        queueWaitTimeMs = Math.max(0, ocrStartTime - createdAtTime);
      }

      // Minimal log: OCR_COMPLETED
      logger.info({
        receiptId: receiptIdStr,
        timeMs: totalProcessingTimeMs,
        queueWaitMs: queueWaitTimeMs,
        openaiMs: openaiTimeMs
      }, 'OCR_COMPLETED');

      // Save result to both result and resultJson for compatibility
      job.status = OcrJobStatus.COMPLETED;
      job.result = result;
      job.resultJson = result;
      job.completedAt = new Date();
      if (tokenUsage?.total_tokens != null) {
        job.totalTokens = tokenUsage.total_tokens;
      }
      await job.save();

      // Update receipt with parsedData and status
      const receiptDocUpdated = await Receipt.findById(job.receiptId).populate({
        path: 'expenseId',
        populate: { path: 'reportId' },
      });

      if (receiptDocUpdated) {
        receiptDocUpdated.parsedData = result;
        receiptDocUpdated.status = ReceiptStatus.COMPLETED;
        receiptDocUpdated.ocrTimeMs = openaiTimeMs;
        receiptDocUpdated.queueWaitTimeMs = queueWaitTimeMs;
        receiptDocUpdated.openaiTimeMs = openaiTimeMs;
        receiptDocUpdated.totalPipelineMs = totalProcessingTimeMs;
        // Set ocrTextHash for receipt-level duplicate detection
        const ocrTextHash = ReceiptHashService.generateOcrTextHash(result);
        if (ocrTextHash) {
          receiptDocUpdated.ocrTextHash = ocrTextHash;
        }
        // Ensure companyId on receipt for duplicate lookup (may already be set in confirmUpload)
        if (receiptDocUpdated.expenseId) {
          const expenseForCompany = receiptDocUpdated.expenseId as any;
          const reportForCompany = expenseForCompany.reportId as any;
          if (reportForCompany?.userId) {
            const { User } = await import('../models/User');
            const userForCompany = await User.findById(reportForCompany.userId).select('companyId').exec();
            if (userForCompany?.companyId) {
              receiptDocUpdated.companyId = userForCompany.companyId as mongoose.Types.ObjectId;
            }
          }
        }
        await receiptDocUpdated.save();

        if (!receiptIdStr) {
          receiptIdStr = (receiptDocUpdated._id as mongoose.Types.ObjectId).toString();
        }

        // Get userId from expense/report for socket emission
        if (receiptDocUpdated.expenseId) {
          const expense = receiptDocUpdated.expenseId as any;
          const report = expense.reportId as any;
          if (report && report.userId) {
            userId = report.userId.toString();
          }
        }

        // Re-run receipt-level duplicate check after OCR (now ocrTextHash is set)
        if (receiptDocUpdated.companyId && receiptIdStr) {
          try {
            const receiptDupResult = await ReceiptDuplicateDetectionService.checkReceiptDuplicate(
              receiptIdStr,
              receiptDocUpdated.companyId as mongoose.Types.ObjectId
            );
            if (receiptDupResult.isDuplicate && receiptDocUpdated.expenseId) {
              const { Expense } = await import('../models/Expense');
              await Expense.findByIdAndUpdate(receiptDocUpdated.expenseId, {
                duplicateFlag: 'STRONG_DUPLICATE',
                duplicateReason: receiptDupResult.reason || 'OCR_TEXT',
              }).exec();
              if (userId) {
                try {
                  const { emitExpenseUpdateToEmployee } = await import('../socket/realtimeEvents');
                  const updatedExpense = await Expense.findById(receiptDocUpdated.expenseId)
                    .select('_id duplicateFlag duplicateReason')
                    .exec();
                  if (updatedExpense) {
                    emitExpenseUpdateToEmployee(userId, {
                      _id: updatedExpense._id,
                      duplicateFlag: updatedExpense.duplicateFlag,
                      duplicateReason: updatedExpense.duplicateReason,
                    });
                  }
                } catch (emitErr) {
                  logger.warn({ error: emitErr }, 'OCR: Failed to emit expense update for receipt duplicate');
                }
              }
            }
          } catch (receiptDupErr) {
            logger.warn({ error: receiptDupErr, receiptId: receiptIdStr }, 'OCR: Receipt duplicate check failed (non-blocking)');
          }
        }
      }

      // No memory cleanup needed - we never loaded images into memory

      // Don't auto-update expenses - user must click submit to save
      // Expenses will only be created/updated when user explicitly saves them

      // Run duplicate detection immediately after OCR using extracted data
      // This allows duplicate detection even before user saves the expense
      if (receiptDocUpdated && receiptDocUpdated.expenseId) {
        try {
          const expense = receiptDocUpdated.expenseId as any;
          const expenseId = (expense._id as mongoose.Types.ObjectId).toString();

          // Get companyId for company-level duplicate detection
          const report = expense.reportId as any;
          let companyId: mongoose.Types.ObjectId | undefined;
          if (report && report.userId) {
            const { User } = await import('../models/User');
            const user = await User.findById(report.userId).select('companyId').exec();
            companyId = user?.companyId as mongoose.Types.ObjectId | undefined;
          }

          // Import Expense model for updating
          const { Expense } = await import('../models/Expense');

          // Update expense with OCR data temporarily for duplicate detection
          // This ensures duplicate detection works even if expense doesn't have vendor/amount yet.
          // Treat placeholder "Processing..." (set by batch upload) as missing so OCR overwrites it.
          const updateData: any = {};
          const currentVendor = expense.vendor ? String(expense.vendor).trim() : '';
          const isPlaceholderVendor = currentVendor === '' || currentVendor === 'Processing...';
          if (result.vendor && isPlaceholderVendor) {
            updateData.vendor = result.vendor;
          }
          if (result.totalAmount && !expense.amount) {
            updateData.amount = result.totalAmount;
            updateData.originalAmount = result.totalAmount;
          }
          // Always prefer receipt-extracted date over placeholder (e.g. report.fromDate); fix incorrect "today" as expense date
          if (result.date) {
            try {
              const normalizedDateStr = OcrService.normalizeOcrDateToYYYYMMDD(result.date);
              if (normalizedDateStr) {
                const { DateUtils } = await import('../utils/dateUtils');
                updateData.expenseDate = DateUtils.frontendDateToBackend(normalizedDateStr);
                updateData.invoiceDate = DateUtils.frontendDateToBackend(normalizedDateStr);
              }
            } catch (dateError) {
              logger.warn({ error: dateError, date: result.date }, 'OCR: Failed to parse date for duplicate detection');
            }
          }
          if (result.invoiceId || result.invoice_number) {
            const invoiceId = (result.invoiceId || result.invoice_number || '').trim();
            if (invoiceId && !expense.invoiceId) {
              updateData.invoiceId = invoiceId;
            }
          }
          if (result.currency && result.currency.trim()) {
            updateData.currency = result.currency.trim().toUpperCase();
            updateData.originalCurrency = result.currency.trim().toUpperCase();
          }

          // Update expense with OCR data if we have any updates
          if (Object.keys(updateData).length > 0) {
            await Expense.findByIdAndUpdate(expenseId, updateData).exec();
            logger.debug({ expenseId, updates: Object.keys(updateData) }, 'OCR: Updated expense with OCR data for duplicate detection');
          }

          // Run duplicate detection with company-level scope
          // Check if we have minimum required data (vendor and amount/date)
          const hasVendor = updateData.vendor || (expense.vendor && String(expense.vendor).trim() !== 'Processing...' ? expense.vendor : null);
          const hasAmount = updateData.amount || expense.amount;
          const hasDate = updateData.expenseDate || updateData.invoiceDate || expense.expenseDate || expense.invoiceDate;

          if (hasVendor && (hasAmount || hasDate)) {
            const { DuplicateDetectionService } = await import('./duplicateDetection.service');
            const duplicateResult = await DuplicateDetectionService.runDuplicateCheck(expenseId, companyId);
            logger.info({
              expenseId,
              receiptId: receiptIdStr,
              duplicateFlag: duplicateResult.duplicateFlag,
              duplicateReason: duplicateResult.duplicateReason,
              companyId: companyId?.toString(),
            }, 'OCR: Company-level duplicate detection completed after OCR');

            // Store duplicate result to include in socket event
            (result as any).duplicateFlag = duplicateResult.duplicateFlag;
            (result as any).duplicateReason = duplicateResult.duplicateReason;

            // Emit expense update event to notify frontend of duplicate flag
            if (duplicateResult.duplicateFlag && report && report.userId) {
              try {
                const { emitExpenseUpdateToEmployee } = await import('../socket/realtimeEvents');
                // Refetch expense with duplicate flag (Expense already imported above)
                const updatedExpense = await Expense.findById(expenseId)
                  .select('_id duplicateFlag duplicateReason vendor amount invoiceId invoiceDate')
                  .exec();
                if (updatedExpense) {
                  emitExpenseUpdateToEmployee(report.userId.toString(), {
                    _id: updatedExpense._id,
                    duplicateFlag: updatedExpense.duplicateFlag,
                    duplicateReason: updatedExpense.duplicateReason,
                  });
                }
              } catch (emitError) {
                logger.warn({ error: emitError }, 'OCR: Failed to emit expense update for duplicate flag');
              }
            }
          } else {
            logger.debug({
              expenseId,
              hasVendor: !!hasVendor,
              hasAmount: !!hasAmount,
              hasDate: !!hasDate,
            }, 'OCR: Skipping duplicate detection - insufficient data');
          }
        } catch (dupError) {
          // Non-blocking - log but don't fail OCR
          logger.warn({ error: dupError, receiptId: receiptIdStr }, 'OCR: Duplicate detection failed after OCR completion');
        }
      }

      // OCR post-processing: category inference and notes from line items
      let companyId: mongoose.Types.ObjectId | undefined;
      if (receiptDocUpdated?.expenseId) {
        const expense = receiptDocUpdated.expenseId as any;
        const report = expense.reportId as any;
        if (report?.userId) {
          const { User } = await import('../models/User');
          const user = await User.findById(report.userId).select('companyId').exec();
          companyId = user?.companyId as mongoose.Types.ObjectId | undefined;
        }
      }
      const fullText = buildFullReceiptText(result);
      const categoryResult = await inferCategoryFromReceiptText(fullText, companyId, {
        vendorText: result.vendor ?? undefined,
      });
      const categorySuggestion = categoryResult.categorySuggestion;
      const categoryId = categoryResult.categoryId ?? null;
      const categoryUnidentified = categoryResult.categoryUnidentified;
      let postProcessNotes = extractNotesFromLineItems(result, {
        vendor: result.vendor ?? undefined,
        categoryName: categoryResult.categorySuggestion ?? undefined,
      }) || null;
      if (!postProcessNotes && result.notes) {
        postProcessNotes = result.notes;
      }
      if (!postProcessNotes && result.lineItems && Array.isArray(result.lineItems) && result.lineItems.length > 0) {
        postProcessNotes = result.lineItems.map((item: { description: string; amount: number }) => `${item.description || ''}: ${item.amount || 0}`).join('\n');
      }

      // Emit socket event for successful OCR completion
      if (userId && receiptIdStr) {
        const duplicateFlag = (result as any).duplicateFlag || null;
        const duplicateReason = (result as any).duplicateReason || null;

        const payload: ReceiptProcessedPayload = {
          receiptId: receiptIdStr,
          status: 'COMPLETED',
          vendor: result.vendor || null,
          date: result.date || null,
          total: result.totalAmount || null,
          currency: result.currency || null,
          invoiceId: result.invoiceId || result.invoice_number || null,
          invoice_number: result.invoice_number || null,
          notes: postProcessNotes,
          lineItems: result.lineItems || null,
          duplicateFlag: duplicateFlag,
          duplicateReason: duplicateReason,
          categorySuggestion: categorySuggestion,
          categoryId: categoryId ? categoryId.toString() : undefined,
          categoryUnidentified: categoryUnidentified,
          isHandwritten: result.isHandwritten ?? undefined,
          doubtfulFields: result.doubtfulFields ?? undefined,
          dateReviewRecommended: result.dateReviewRecommended ?? undefined,
          exchangeRate: result.exchangeRate ?? undefined,
          batchId: receiptDocUpdated?.batchId ?? undefined,
        };
        emitReceiptProcessed(userId, receiptIdStr, payload);
        if (receiptDocUpdated?.batchId && userId) {
          await updateBatchProgressAndEmit(userId, receiptDocUpdated.batchId, true);
        }
      }

      // Persist inferred categoryId to expense so getExpenseById returns it for batch UI
      if (receiptDocUpdated?.expenseId && categoryId) {
        try {
          const { Expense } = await import('../models/Expense');
          const exp = receiptDocUpdated.expenseId as any;
          const expenseIdStr = exp._id ? exp._id.toString() : exp.toString();
          await Expense.findByIdAndUpdate(expenseIdStr, { categoryId }).exec();
          logger.debug({ expenseId: expenseIdStr, categoryId: categoryId.toString() }, 'OCR: Persisted categoryId to expense');
        } catch (persistErr) {
          logger.warn({ error: persistErr, receiptId: receiptIdStr }, 'OCR: Failed to persist categoryId to expense (non-blocking)');
        }
      }

      return job;
    } catch (error: any) {
      const totalProcessingTimeMs = Date.now() - ocrStartTime;

      // Determine failure reason
      let failureReason: ReceiptFailureReason = ReceiptFailureReason.API_ERROR;
      if (error.message?.includes('timeout') || error.message?.includes('timed out') || totalProcessingTimeMs >= config.ocr.timeoutMs) {
        failureReason = ReceiptFailureReason.TIMEOUT;
      } else if (error.message?.includes('unreadable') || error.message?.includes('No response')) {
        failureReason = ReceiptFailureReason.UNREADABLE;
      }

      job.status = OcrJobStatus.FAILED;
      job.error = error.message;
      job.errorJson = {
        message: error.message,
      };
      job.attempts = (job.attempts || 0) + 1;
      await job.save();

      // Minimal log: OCR_FAILED
      logger.error({ receiptId: receiptIdStr, reason: failureReason }, 'OCR_FAILED');

      // Update receipt status to FAILED
      const receiptDocFailed = await Receipt.findById(job.receiptId).populate({
        path: 'expenseId',
        populate: { path: 'reportId' },
      });

      if (receiptDocFailed) {
        receiptDocFailed.status = ReceiptStatus.FAILED;
        receiptDocFailed.failureReason = failureReason;
        receiptDocFailed.totalPipelineMs = totalProcessingTimeMs;
        await receiptDocFailed.save();

        const failedReceiptIdStr = (receiptDocFailed._id as mongoose.Types.ObjectId).toString();

        // Get userId for socket emission
        let failedUserId: string | null = null;
        if (receiptDocFailed.expenseId) {
          const expense = receiptDocFailed.expenseId as any;
          const report = expense.reportId as any;
          if (report && report.userId) {
            failedUserId = report.userId.toString();
          }
        }

        // Emit socket event for failed OCR
        if (failedUserId && failedReceiptIdStr) {
          emitReceiptProcessed(failedUserId, failedReceiptIdStr, {
            receiptId: failedReceiptIdStr,
            status: 'FAILED',
            reason: failureReason,
            batchId: receiptDocFailed?.batchId ?? undefined,
          });
          if (receiptDocFailed?.batchId && failedUserId) {
            await updateBatchProgressAndEmit(failedUserId, receiptDocFailed.batchId, false);
          }
        }
      }

      throw error;
    }
  }

  /**
   * Call OpenAI Vision API with timeout handling using Promise.race
   */
  private static async callOpenAIVisionWithTimeout(
    presignedUrl: string,
    _mimeType: string,
    timeoutMs: number
  ): Promise<{ result: OcrResult; usage?: { total_tokens: number } }> {
    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('OCR request timed out'));
      }, timeoutMs);
    });

    // Race between OCR call and timeout (gpt-4o-mini only - no fallback)
    try {
      return await Promise.race([
        this.callOpenAIVision(presignedUrl, _mimeType, getVisionModel()),
        timeoutPromise,
      ]);
    } catch (error: any) {
      // Check if timeout occurred
      if (error.message?.includes('timed out')) {
        throw new Error('OCR request timed out');
      }
      throw error;
    }
  }

  /**
   * Call OpenAI Vision API with configured model (gpt-4o-mini only; no fallback)
   */
  private static async callOpenAIVision(
    presignedUrl: string,
    _mimeType: string,
    model: string = getVisionModel()
  ): Promise<{ result: OcrResult; usage?: { total_tokens: number } }> {
    const prompt = `Extract receipt data from this image. The receipt may be PRINTED or HANDWRITTEN, and may be in English, Hindi, Marathi, or other Indian languages. Return JSON only:
{
  "vendor": string | null,
  "date": string | null,
  "total": number | null,
  "currency": string | null,
  "invoice_number": string | null,
  "line_items": [{"description": string, "quantity": number | null, "amount": number}],
  "is_handwritten": boolean,
  "doubtful_fields": string[] | null,
  "date_review_recommended": boolean,
  "exchange_rate": number | null
}

HANDWRITTEN RECEIPTS:
- If the receipt is handwritten (fully or partly), set "is_handwritten": true.
- For handwritten text, extract as best you can. For any field where you are unsure (e.g. unclear digits, ambiguous characters), add that field name to "doubtful_fields" so the user can recheck. Use field names: "vendor", "date", "total", "invoice_number", "line_items", "currency".
- Support handwritten text in English, Hindi (Devanagari), and Marathi (Devanagari). Extract dates, numbers, and names correctly for Indian language receipts.

VENDOR NAME:
- Extract the merchant/shop/recipient name clearly. For handwritten or faded text, still attempt extraction and add "vendor" to doubtful_fields if uncertain.
- For UPI/payment receipts, vendor is often the recipient name or app name.

TRANSACTION / INVOICE NUMBER (CRITICAL — extract as accurately as possible):
- ALWAYS try to extract ANY identifier: Invoice Number, Invoice No, Bill No, Receipt No, UPI Ref No, UPI Reference Number, Transaction ID, Transaction Reference, Txn ID, Txn Ref, Payment Reference, Payment ID, Order ID, Order Number, Ref No, Reference No, UTR, UTR No, RRN (Retrieval Reference Number), VPA Ref, Bank Ref. Put the value in "invoice_number".
- For Paytm payment receipts, the identifier is often shown as "Paytm Txn ID", "Order ID", "UPI Ref No", "UTR", or "RRN" — extract whichever is present.
- Look in headers, footers, and small print. Values are often alphanumeric (e.g. INV-2024-001, TXN123456, 123456789012).
- If you SEE an invoice/bill/transaction/reference number on the receipt but cannot read it clearly (blurry, handwritten, cropped), add "invoice_number" to "doubtful_fields" so the user is prompted to enter it manually.
- If the field is clearly present but in an unusual format, still extract the raw string and add "invoice_number" to doubtful_fields if uncertain.

DATE EXTRACTION - CRITICAL:
- Support formats: dd/mm/yyyy, dd-mm-yyyy, mm/dd/yyyy, yyyy-mm-dd, and 2-digit year (dd-mm-yy, dd/mm/yy).
- If the date uses 2-digit year (e.g. 26-01-23, 15/03/24), convert to YYYY-MM-DD using sensible century (e.g. 23 → 2023, 24 → 2024) and set "date_review_recommended": true so the user can confirm.
- If day > 12, that number is the day (not month). For INR/Indian receipts, prefer dd/mm/yyyy when ambiguous.
- Always return date in YYYY-MM-DD. If format is ambiguous (e.g. 01-02-24 could be Jan 2 or Feb 1), pick the most likely and set date_review_recommended: true.

EXCHANGE RATE:
- If the receipt shows an exchange rate (e.g. "1 USD = 83.50 INR"), extract it as a number in "exchange_rate". Otherwise null.

CURRENCY & TOTAL (CRITICAL — do NOT default to INR unless receipt is clearly in Indian Rupees):
- Extract total amount as a number (no symbol). Extract currency as 3-letter code.
- Map currency symbols to codes: $ or USD or dollars → USD; € or EUR or euros → EUR; £ or GBP or pounds → GBP; ¥ or JPY or yen → JPY; ₹ or INR or Rupees or Rs → INR.
- If the receipt shows $, €, £, ¥, or any non-INR symbol/code, return that currency (USD, EUR, GBP, JPY, etc.). Do NOT use INR for dollar/euro/pound receipts.
- Use INR only when you see ₹ or the text explicitly says INR, Rupees, Rs, or Indian Rupees.
- If currency cannot be determined from the receipt, return null.
- For multi-currency receipts, extract both amounts if shown and exchange_rate if present.

LINE ITEMS:
- Extract each item: description, quantity (if shown), amount. For handwritten lists, do your best and add "line_items" to doubtful_fields if unclear.

If unreadable, return null. No explanations.`;

    try {
      // OpenAI vision API format
      const response = await openaiClient.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: presignedUrl, // S3 presigned URL - OpenAI fetches directly
                  detail: 'high', // Use high detail for better OCR accuracy
                },
              },
            ],
          },
        ],
        max_tokens: 2000,
        response_format: { type: 'json_object' }, // Force JSON response format
        temperature: 0.0, // Zero temperature for fastest, most consistent results
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      const usage = response.usage
        ? { total_tokens: response.usage.total_tokens ?? (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0) }
        : undefined;

      // Clean the content - remove markdown code blocks if present
      let cleanedContent = content.trim();
      if (cleanedContent.startsWith('```json')) {
        cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedContent.startsWith('```')) {
        cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      // Parse JSON response
      try {
        const parsed = JSON.parse(cleanedContent);
        // Map simplified OpenAI response format to our internal format
        // Extract invoice number from multiple possible fields (including UPI Reference, Transaction ID, UTR, etc.)
        const invoiceNumber = parsed.invoice_number ||
          parsed.invoiceId ||
          parsed.invoice_id ||
          parsed.invoiceNo ||
          parsed.invoice_no ||
          parsed.billNo ||
          parsed.bill_no ||
          parsed.upi_ref_no ||
          parsed.upi_reference_number ||
          parsed.upiRefNo ||
          parsed.transaction_id ||
          parsed.transactionId ||
          parsed.txn_id ||
          parsed.txn_ref ||
          parsed.txnRef ||
          parsed.payment_reference ||
          parsed.paymentReference ||
          parsed.payment_id ||
          parsed.paymentId ||
          parsed.order_id ||
          parsed.orderId ||
          parsed.rrn ||
          parsed.rrn_no ||
          parsed.rrnNo ||
          parsed.retrieval_reference_number ||
          parsed.retrievalReferenceNumber ||
          parsed.receipt_number ||
          parsed.receiptNumber ||
          parsed.ref_no ||
          parsed.refNo ||
          parsed.reference_no ||
          parsed.referenceNumber ||
          parsed.ref_number ||
          parsed.refNumber ||
          parsed.utr ||
          parsed.utr_no ||
          parsed.utrNo ||
          parsed.vpa_ref ||
          parsed.bank_ref ||
          null;

        const lineItemsRaw = parsed.line_items || parsed.lineItems;
        const lineItems: Array<{ description: string; amount: number }> = Array.isArray(lineItemsRaw)
          ? lineItemsRaw
            .filter((item: any) => item && (item.description != null || item.desc != null))
            .map((item: any) => ({
              description: String(item.description ?? item.desc ?? '').trim(),
              amount: typeof item.amount === 'number' ? item.amount : parseFloat(String(item.amount || 0)) || 0,
            }))
            .filter((item) => item.description.length > 0)
          : [];

        const doubtfulFieldsRaw = parsed.doubtful_fields ?? parsed.doubtfulFields;
        let doubtfulFields: string[] = Array.isArray(doubtfulFieldsRaw)
          ? doubtfulFieldsRaw.filter((f: any) => typeof f === 'string').map((f: string) => f.trim()).filter(Boolean)
          : [];
        // If invoice number was not extracted, add invoiceId to doubtfulFields so UI highlights the field for manual entry
        const hasInvoiceInDoubtful = doubtfulFields.some((f: string) => f === 'invoice_number' || f === 'invoiceId');
        if ((!invoiceNumber || String(invoiceNumber).trim() === '') && !hasInvoiceInDoubtful) {
          doubtfulFields = [...doubtfulFields, 'invoiceId'];
        }
        // If currency was not extracted, add currency to doubtfulFields so user can select manually
        const hasCurrencyInDoubtful = doubtfulFields.some((f: string) => f === 'currency');
        const extractedCurrency = parsed.currency && String(parsed.currency).trim();
        if (!extractedCurrency && !hasCurrencyInDoubtful) {
          doubtfulFields = [...doubtfulFields, 'currency'];
        }

        const result: OcrResult = {
          vendor: parsed.vendor || null,
          date: parsed.date || null,
          totalAmount: parsed.total != null ? Number(parsed.total) : undefined,
          currency: parsed.currency && String(parsed.currency).trim() ? String(parsed.currency).trim().toUpperCase() : undefined,
          invoice_number: invoiceNumber,
          invoiceId: invoiceNumber,
          lineItems: lineItems.length > 0 ? lineItems : undefined,
          notes: parsed.notes || undefined,
          confidence: 0.85,
          isHandwritten: Boolean(parsed.is_handwritten ?? parsed.isHandwritten),
          doubtfulFields: doubtfulFields.length > 0 ? doubtfulFields : undefined,
          dateReviewRecommended: Boolean(parsed.date_review_recommended ?? parsed.dateReviewRecommended),
          exchangeRate: parsed.exchange_rate != null ? Number(parsed.exchange_rate) : parsed.exchangeRate != null ? Number(parsed.exchangeRate) : undefined,
        };

        return { result, usage };
      } catch (error) {
        // If not JSON, try to extract structured data
        const parsed = this.parseUnstructuredResponse(cleanedContent);
        return { result: parsed, usage };
      }
    } catch (error: any) {
      // usage is not available on error path
      // Provide more helpful error messages
      if (error.message?.includes('model') || error.code === 'invalid_model' || error.status === 404) {
        throw new Error(
          `OpenAI model "${model}" not found or not available.\n` +
          `Please check:\n` +
          `1. Model name is correct in .env file (OPENAI_MODEL_VISION)\n` +
          `2. Model is available in your OpenAI account\n` +
          `3. Model supports vision/image inputs\n` +
          `Recommended vision models: gpt-4o, gpt-4o-mini, gpt-4-turbo`
        );
      } else if (error.message?.includes('vision') || error.message?.includes('image')) {
        throw new Error(
          `OpenAI model "${model}" may not support vision/image inputs.\n` +
          `Please use a vision-capable model like: gpt-4o`
        );
      } else if (error.status === 401 || error.message?.includes('authentication') || error.message?.includes('Unauthorized')) {
        throw new Error(
          'OpenAI authentication failed.\n' +
          'Please check:\n' +
          '1. OPENAI_API_KEY is set correctly in .env file\n' +
          '2. API key is valid and has sufficient credits\n' +
          '3. API key has access to vision models'
        );
      } else if (error.status === 429 || error.message?.includes('rate limit')) {
        throw new Error(
          'OpenAI rate limit exceeded.\n' +
          'Please wait a moment and try again, or check your OpenAI account limits.'
        );
      }

      throw new Error(`OpenAI API error: ${error.message || 'Unknown error'}\nStatus: ${error.status || 'N/A'}\nCode: ${error.code || 'N/A'}`);
    }
  }

  /**
   * Normalize OCR date string to YYYY-MM-DD so expense persistence and validation work.
   * Handles YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, MM-DD-YYYY.
   */
  private static normalizeOcrDateToYYYYMMDD(dateStr: string): string | null {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const s = dateStr.trim();
    if (!s) return null;
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // DD-MM-YYYY or DD/MM/YYYY (Indian style)
    const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (dmy) {
      const [, d, m, y] = dmy;
      const day = d!.padStart(2, '0');
      const month = m!.padStart(2, '0');
      return `${y}-${month}-${day}`;
    }
    // YYYY-MM-DD with extra spaces
    const iso = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (iso) {
      const [, y, m, d] = iso;
      return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
    }
    return null;
  }

  private static parseUnstructuredResponse(content: string): OcrResult {
    // Fallback parser for non-JSON responses
    const result: OcrResult = {};

    // Try to extract vendor - multiple patterns
    const vendorPatterns = [
      /vendor[:\s]+([^\n,]+)/i,
      /merchant[:\s]+([^\n,]+)/i,
      /store[:\s]+([^\n,]+)/i,
      /"vendor"\s*:\s*"([^"]+)"/i,
    ];

    for (const pattern of vendorPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        result.vendor = match[1].trim();
        break;
      }
    }

    // Try to extract amount - multiple patterns (order matters: symbol-based first to infer currency)
    const amountPatterns: { pattern: RegExp; currency?: string }[] = [
      { pattern: /₹\s*([\d,]+\.?\d*)/i, currency: 'INR' },
      { pattern: /\$\s*([\d,]+\.?\d*)/, currency: 'USD' },
      { pattern: /€\s*([\d,]+\.?\d*)/, currency: 'EUR' },
      { pattern: /£\s*([\d,]+\.?\d*)/, currency: 'GBP' },
      { pattern: /¥\s*([\d,]+\.?\d*)/, currency: 'JPY' },
      { pattern: /total[:\s]+([\d.]+)/i },
      { pattern: /amount[:\s]+([\d.]+)/i },
      { pattern: /"totalAmount"\s*:\s*([\d.]+)/i },
      { pattern: /(\d+\.\d{2})/ },
    ];

    for (const { pattern, currency: inferredCurrency } of amountPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        const amountStr = match[1].replace(/,/g, '');
        const amount = parseFloat(amountStr);
        if (!isNaN(amount) && amount > 0) {
          result.totalAmount = amount;
          if (inferredCurrency && !result.currency) {
            result.currency = inferredCurrency;
          }
          break;
        }
      }
    }

    // Try to extract date - multiple patterns
    const datePatterns = [
      /date[:\s]+([\d-]+)/i,
      /"date"\s*:\s*"([^"]+)"/i,
      /(\d{4}-\d{2}-\d{2})/,
      /(\d{2}\/\d{2}\/\d{4})/,
      /(\d{2}-\d{2}-\d{4})/,
    ];

    for (const pattern of datePatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        result.date = match[1];
        break;
      }
    }

    // Try to extract currency
    const currencyMatch = content.match(/"currency"\s*:\s*"([^"]+)"/i) ||
      content.match(/currency[:\s]+([A-Z]{3})/i);
    if (currencyMatch) {
      result.currency = currencyMatch[1].trim().toUpperCase();
    }

    // Try to extract invoice ID / transaction reference (multiple patterns for accuracy)
    const invoicePatterns = [
      /"invoice_number"\s*:\s*"([^"]*)"/i,
      /"invoiceId"\s*:\s*"([^"]*)"/i,
      /(?:invoice|inv|bill|receipt)\s*(?:no|number|#)?[:\s]*([A-Z0-9][A-Z0-9\-\/]{2,50})/im,
      /(?:transaction|txn|payment)\s*(?:id|ref|reference)?[:\s]*([A-Z0-9][A-Z0-9\-\/]{4,50})/im,
      /(?:upi|ref|reference)\s*(?:no|number)?[:\s]*([A-Z0-9][A-Z0-9\-\s]{4,50})/im,
      /(?:utr|order)\s*(?:no|number|id)?[:\s]*([A-Z0-9][A-Z0-9\-\/]{4,50})/im,
      /(?:rrn|retrieval\s*reference)\s*(?:no|number)?[:\s]*([A-Z0-9][A-Z0-9\-\/]{4,50})/im,
      /(?:gstin|gst)\s*(?:no|number)?[:\s]*([A-Z0-9]{8,})/im,
    ];
    for (const pattern of invoicePatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        const val = match[1].trim().substring(0, 100);
        if (val.length >= 2) {
          result.invoiceId = val;
          result.invoice_number = val;
          break;
        }
      }
    }
    // If still no invoice ID, mark for user to enter manually
    if (!result.invoiceId || String(result.invoiceId).trim() === '') {
      result.doubtfulFields = [...(result.doubtfulFields || []), 'invoiceId'];
    }

    return result;
  }

  static async getOcrJobStatus(id: string): Promise<IOcrJob | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return OcrJob.findById(id).populate('receiptId').exec();
  }
}

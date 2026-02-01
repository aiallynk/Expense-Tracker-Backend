import { randomUUID } from 'crypto';

import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { Receipt } from '../models/Receipt';
import { DocumentProcessingService } from '../services/documentProcessing.service';
import { BatchUploadService } from '../services/batchUpload.service';
import { bulkDocumentUploadIntentSchema, bulkDocumentConfirmSchema, batchUploadIntentSchema, batchUploadConfirmSchema } from '../utils/dtoTypes';
import { getPresignedUploadUrl, getObjectUrl } from '../utils/s3';

import { logger } from '@/config/logger';

export class BulkUploadController {
  /**
   * Create upload intent for bulk document (PDF, Excel, or image with multiple receipts)
   */
  static createUploadIntent = asyncHandler(
    async (req: AuthRequest, res: Response) => {
      const data = bulkDocumentUploadIntentSchema.parse(req.body);
      const userId = req.user!.id;

      // Validate mime type
      if (!DocumentProcessingService.isSupportedMimeType(data.mimeType)) {
        res.status(400).json({
          success: false,
          message: 'Unsupported file type',
          code: 'UNSUPPORTED_FILE_TYPE',
          supportedTypes: DocumentProcessingService.getSupportedMimeTypes(),
        });
        return;
      }

      // Generate storage key for bulk uploads
      const storageKey = `bulk-uploads/${data.reportId}/${randomUUID()}-${Date.now()}`;

      logger.info({
        userId,
        reportId: data.reportId,
        filename: data.filename,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        storageKey,
      }, 'Creating bulk upload intent');

      // Create Receipt document upfront for the bulk document
      const receipt = new Receipt({
        storageKey,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        storageUrl: getObjectUrl('receipts', storageKey),
        uploadConfirmed: false,
        parsedData: {
          isBulkDocument: true,
          originalFilename: data.filename,
          reportId: data.reportId,
        },
      });

      const savedReceipt = await receipt.save();

      const uploadUrl = await getPresignedUploadUrl({
        bucketType: 'receipts',
        key: storageKey,
        mimeType: data.mimeType,
        expiresIn: 3600, // 1 hour
      });

      const storageUrl = getObjectUrl('receipts', storageKey);

      res.status(200).json({
        success: true,
        data: {
          uploadUrl,
          storageKey,
          storageUrl,
          receiptId: (savedReceipt._id as mongoose.Types.ObjectId).toString(), // Return receipt ID for linking
          expiresIn: 3600,
          supportedTypes: DocumentProcessingService.getSupportedMimeTypes(),
        },
      });
    }
  );

  /**
   * Confirm bulk upload and process document for multiple receipt extraction
   * Optimized: Reduced delay, streams processing
   */
  static confirmUpload = asyncHandler(
    async (req: AuthRequest, res: Response) => {
      const data = bulkDocumentConfirmSchema.parse(req.body);
      const userId = req.user!.id;

      logger.info({
        userId,
        reportId: data.reportId,
        storageKey: data.storageKey,
        mimeType: data.mimeType,
        receiptId: data.receiptId,
      }, 'Confirming bulk upload and processing document');

      // Reduced delay - just 500ms for S3 propagation
      await new Promise(resolve => setTimeout(resolve, 500));

      // Always return HTTP 200 - OCR failures are non-blocking
      let result: any;
      try {
        // Update receipt to confirm upload (non-blocking; invalid receiptId must not abort)
        if (data.receiptId) {
          try {
            await Receipt.findByIdAndUpdate(data.receiptId, {
              uploadConfirmed: true,
            });
          } catch (_) {
            // Ignore invalid receiptId so processDocument still runs
          }
        }

        result = await DocumentProcessingService.processDocument(
          data.storageKey,
          data.mimeType,
          data.reportId,
          userId,
          data.receiptId, // Pass receipt ID for linking
          data.skipExpenseCreation || false // Skip expense creation if requested
        );
      } catch (error: any) {
        // Even if processDocument throws (non-OCR errors), return HTTP 200 with empty results
        // Only non-OCR errors should throw (S3 access, invalid report, etc.)
        // OCR errors are handled inside processDocument and never throw
        
        // Check if it's a non-OCR error (S3, report validation, etc.)
        const isNonOcrError = error.message?.includes('Report not found') || 
                              error.message?.includes('Access denied') ||
                              error.message?.includes('S3') ||
                              error.message?.includes('Unsupported document type');
        
        if (isNonOcrError) {
          // Non-OCR errors: return HTTP 400 (these are real failures)
          logger.error({
            userId,
            reportId: data.reportId,
            error: error.message,
          }, 'Bulk document processing failed (non-OCR error)');

          res.status(400).json({
            success: false,
            message: error.message,
            code: 'DOCUMENT_PROCESSING_FAILED',
          });
          return;
        }
        
        // OCR-related errors: return HTTP 200 with empty results
        result = {
          success: false,
          receipts: [],
          expensesCreated: [],
          results: [],
          errors: [error.message],
          documentType: data.mimeType.startsWith('image/') ? 'image' : data.mimeType === 'application/pdf' ? 'pdf' : 'excel',
          totalPages: 0,
        };
      }

      const createdExpenseIds = (result?.expensesCreated || []).filter(
        (id: any): id is string => typeof id === 'string' && id.length > 0
      );

      // Update receipt with processing results (non-blocking; invalid receiptId must not cause 500)
      if (data.receiptId) {
        try {
          await Receipt.findByIdAndUpdate(data.receiptId, {
            parsedData: {
              isBulkDocument: true,
              reportId: data.reportId,
              receiptsExtracted: (result?.receipts || []).length,
              expensesLinked: createdExpenseIds,
              processedAt: new Date(),
            },
          });
        } catch (updateErr: any) {
          logger.warn({ receiptId: data.receiptId, error: updateErr?.message }, 'Failed to update receipt parsedData (non-fatal)');
        }
      }

      // Log summary - only one log per batch
      const errorsList = result?.errors ?? [];
      const ocrFailures = errorsList.filter((e: string) => e.includes('OCR') || e.includes('parsing')).length;
      const receiptsList = result?.receipts ?? [];
      if (ocrFailures > 0 && receiptsList.length === 0) {
        logger.warn({
          userId,
          reportId: data.reportId,
          ocrFailures,
        }, 'Bulk document processed with OCR failures');
      } else {
        logger.info({
          userId,
          reportId: data.reportId,
          receiptsFound: receiptsList.length,
          expensesCreated: createdExpenseIds.length,
          errors: errorsList.length,
        }, 'Bulk document processed');
      }

      // Always return HTTP 200 - success is true if any receipts were extracted
      res.status(200).json({
        success: receiptsList.length > 0,
        data: {
          documentType: result?.documentType,
          totalPages: result?.totalPages,
          receiptsExtracted: receiptsList.length,
          expensesCreated: result?.expensesCreated,
          extractedData: result?.receipts,
          results: result?.results,
          documentReceiptId: data.receiptId, // Include receipt ID for frontend
          storageKey: data.storageKey,
          errors: errorsList,
          ocrFailures,
        },
        message: receiptsList.length > 0
          ? `Successfully extracted ${receiptsList.length} receipt(s) and created ${createdExpenseIds.length} expense draft(s)`
          : errorsList.length > 0
            ? 'Document uploaded but OCR failed. Please enter receipt details manually.'
            : 'Document uploaded successfully',
      });
    }
  );

  /**
   * Batch upload intent: create all receipts for a batch, return presigned URLs.
   * One API call for the entire batch. Do NOT wait for OCR.
   */
  static createBatchIntent = asyncHandler(
    async (req: AuthRequest, res: Response) => {
      const data = batchUploadIntentSchema.parse(req.body);
      const userId = req.user!.id;

      const result = await BatchUploadService.createBatchIntent(
        data.reportId,
        userId,
        data.batchId,
        data.files
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    }
  );

  /**
   * Batch upload confirm: create expense drafts, link receipts, enqueue all OCR jobs.
   * Respond once. Do NOT wait for OCR to finish.
   */
  static confirmBatch = asyncHandler(
    async (req: AuthRequest, res: Response) => {
      const data = batchUploadConfirmSchema.parse(req.body);
      const userId = req.user!.id;

      const result = await BatchUploadService.confirmBatch(
        data.reportId,
        userId,
        data.batchId,
        data.receipts
      );

      res.status(200).json({
        success: true,
        data: result,
        message: `Processing ${result.receiptIds.length} receipt(s). Results will appear as they complete.`,
      });
    }
  );

  /**
   * Get batch status by batchId (auth user must own the batch).
   */
  static getBatchStatus = asyncHandler(
    async (req: AuthRequest, res: Response) => {
      const batchId = req.params.batchId as string;
      const userId = req.user!.id;

      const status = await BatchUploadService.getBatchStatus(batchId, userId);
      if (!status) {
        res.status(404).json({
          success: false,
          message: 'Batch not found or access denied',
          code: 'BATCH_NOT_FOUND',
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: status,
      });
    }
  );

  /**
   * Retry OCR for failed receipts in the batch only.
   */
  static retryFailedReceipts = asyncHandler(
    async (req: AuthRequest, res: Response) => {
      const batchId = req.params.batchId as string;
      const userId = req.user!.id;

      const result = await BatchUploadService.retryFailedReceipts(batchId, userId);

      res.status(200).json({
        success: true,
        data: {
          batchId,
          receiptIds: result.receiptIds,
          enqueued: result.enqueued,
        },
        message: result.enqueued > 0
          ? `Re-queued ${result.enqueued} failed receipt(s) for OCR.`
          : 'No failed receipts to retry.',
      });
    }
  );

  /**
   * Get supported file types for bulk upload
   */
  static getSupportedTypes = asyncHandler(
    async (_req: AuthRequest, res: Response) => {
      res.status(200).json({
        success: true,
        data: {
          supportedMimeTypes: DocumentProcessingService.getSupportedMimeTypes(),
          supportedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.xlsx', '.xls', '.csv'],
          description: {
            images: 'Single or multiple receipts in one image',
            pdf: 'PDF documents with one or more receipts across pages',
            excel: 'Excel/CSV files with expense data in rows (requires headers: vendor/merchant, amount/total)',
          },
        },
      });
    }
  );
}


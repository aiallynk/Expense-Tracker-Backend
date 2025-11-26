import { randomUUID } from 'crypto';

import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { DocumentProcessingService } from '../services/documentProcessing.service';
import { bulkDocumentUploadIntentSchema, bulkDocumentConfirmSchema } from '../utils/dtoTypes';
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
          expiresIn: 3600,
          supportedTypes: DocumentProcessingService.getSupportedMimeTypes(),
        },
      });
    }
  );

  /**
   * Confirm bulk upload and process document for multiple receipt extraction
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
      }, 'Confirming bulk upload and processing document');

      // Small delay to ensure S3 upload has fully propagated
      await new Promise(resolve => setTimeout(resolve, 1500));

      try {
        const result = await DocumentProcessingService.processDocument(
          data.storageKey,
          data.mimeType,
          data.reportId,
          userId
        );

        logger.info({
          userId,
          reportId: data.reportId,
          receiptsFound: result.receipts.length,
          expensesCreated: result.expensesCreated.length,
          errors: result.errors.length,
        }, 'Bulk document processed');

        res.status(200).json({
          success: result.success,
          data: {
            documentType: result.documentType,
            totalPages: result.totalPages,
            receiptsExtracted: result.receipts.length,
            expensesCreated: result.expensesCreated,
            extractedData: result.receipts,
            errors: result.errors,
          },
          message: result.success 
            ? `Successfully extracted ${result.receipts.length} receipt(s) and created ${result.expensesCreated.length} expense draft(s)`
            : 'Document processing completed with errors',
        });
      } catch (error: any) {
        logger.error({
          userId,
          reportId: data.reportId,
          error: error.message,
        }, 'Bulk document processing failed');

        res.status(400).json({
          success: false,
          message: error.message,
          code: 'DOCUMENT_PROCESSING_FAILED',
        });
      }
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


import { randomUUID } from 'crypto';

import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { Receipt, IReceipt } from '../models/Receipt';
import { User } from '../models/User';
// import { ExpenseReport } from '../models/ExpenseReport'; // Unused - accessed via populate
import { UploadIntentDto } from '../utils/dtoTypes';
import { getPresignedUploadUrl, getObjectUrl, getPresignedDownloadUrl } from '../utils/s3';



import { OcrService } from './ocr.service';

import { logger } from '@/config/logger';

export class ReceiptsService {
  static async createUploadIntent(
    expenseId: string,
    userId: string,
    data: UploadIntentDto
  ): Promise<{ receiptId: string; uploadUrl: string; storageKey: string }> {
    const expense = await Expense.findById(expenseId).populate('reportId');

    if (!expense) {
      throw new Error('Expense not found');
    }

    const report = expense.reportId as any;

    if (report.userId.toString() !== userId) {
      throw new Error('Access denied');
    }

    // Generate storage key (bucket is assumed to exist)
    const storageKey = `receipts/${expenseId}/${randomUUID()}-${Date.now()}`;
    
    logger.info({
      expenseId,
      userId,
      filename: data.filename,
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes,
      storageKey,
    }, 'Creating upload intent')
    
    const uploadUrl = await getPresignedUploadUrl({
      bucketType: 'receipts',
      key: storageKey,
      mimeType: data.mimeType,
      expiresIn: 3600, // 1 hour
    });

    const storageUrl = getObjectUrl('receipts', storageKey);

    const receipt = new Receipt({
      expenseId,
      storageKey,
      storageUrl,
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes || 0,
      uploadConfirmed: false,
    });

    const saved = await receipt.save();
    
    logger.info({
      receiptId: saved._id,
      expenseId,
      storageKey,
      storageUrl,
    }, 'Receipt created for upload')

    // Link receipt to expense
    if (!expense.receiptIds) {
      expense.receiptIds = [];
    }
    expense.receiptIds.push(saved._id as mongoose.Types.ObjectId);
    
    // Set as primary if it's the first one
    if (!expense.receiptPrimaryId) {
      expense.receiptPrimaryId = saved._id as mongoose.Types.ObjectId;
    }
    await expense.save();

    return {
      receiptId: (saved._id as mongoose.Types.ObjectId).toString(),
      uploadUrl,
      storageKey,
    };
  }

  static async confirmUpload(
    receiptId: string,
    userId: string
  ): Promise<{ receipt: IReceipt; ocrJobId: string; extractedFields?: any }> {
    const receipt = await Receipt.findById(receiptId).populate({
      path: 'expenseId',
      populate: { path: 'reportId' },
    });

    if (!receipt) {
      throw new Error('Receipt not found');
    }

    // If expenseId exists, check access via report
    if (receipt.expenseId) {
    const expense = receipt.expenseId as any;
    const report = expense.reportId as any;

      if (report && report.userId.toString() !== userId) {
      throw new Error('Access denied');
      }
    }

    // Mark upload as confirmed
    receipt.uploadConfirmed = true;
    await receipt.save();
    
    logger.info({
      receiptId,
      userId,
      storageKey: receipt.storageKey,
      storageUrl: receipt.storageUrl,
    }, 'Receipt upload confirmed')

    // Small delay to ensure S3 upload has fully propagated
    // S3 eventual consistency can cause issues if we try to read immediately
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Generate signed URL for the receipt (valid for 7 days)
    const signedUrl = await getPresignedDownloadUrl(
      'receipts',
      receipt.storageKey,
      7 * 24 * 60 * 60 // 7 days
    );

    const signedUrlExpiresAt = new Date();
    signedUrlExpiresAt.setDate(signedUrlExpiresAt.getDate() + 7);

    // Store receipt URL in user collection
    const user = await User.findById(userId);
    if (user) {
      // Check if receipt already exists in user's receiptUrls
      const existingReceiptIndex = user.receiptUrls?.findIndex(
        (r) => r.receiptId.toString() === receiptId
      );

      const receiptUrlData = {
        receiptId: receipt._id as mongoose.Types.ObjectId,
        storageUrl: receipt.storageUrl,
        signedUrl,
        signedUrlExpiresAt,
        uploadedAt: new Date(),
      };

      if (existingReceiptIndex !== undefined && existingReceiptIndex >= 0) {
        // Update existing entry
        if (user.receiptUrls) {
          user.receiptUrls[existingReceiptIndex] = receiptUrlData;
        }
      } else {
        // Add new entry
        if (!user.receiptUrls) {
          user.receiptUrls = [];
        }
        user.receiptUrls.push(receiptUrlData);
      }

      await user.save();
      logger.info({
        userId,
        receiptId,
        storageUrl: receipt.storageUrl,
      }, 'Receipt URL stored in user collection')
    }

    // Process OCR synchronously (no queue)
    let ocrJobId: string | null = null;
    let extractedFields: any = null;
    
    try {
      logger.info({ 
        receiptId,
        storageKey: receipt.storageKey,
        storageUrl: receipt.storageUrl,
      }, 'Starting OCR processing');
      
      // Verify file exists in S3 before processing OCR
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const { s3Client, getS3Bucket } = await import('../config/aws');
      const bucket = getS3Bucket('receipts');
      
      try {
        const headCommand = new HeadObjectCommand({
          Bucket: bucket,
          Key: receipt.storageKey,
        });
        await s3Client.send(headCommand);
        logger.info({ receiptId, storageKey: receipt.storageKey }, 'Receipt verified in S3 before OCR');
      } catch (s3Error: any) {
        if (s3Error.name === 'NotFound' || s3Error.$metadata?.httpStatusCode === 404) {
          logger.error({
            receiptId,
            storageKey: receipt.storageKey,
          }, 'Receipt not found in S3 - upload may not have completed. OCR will be skipped.');
          // Don't throw - allow the confirm to succeed, OCR can be retried later
          return {
            receipt,
            ocrJobId: '',
            extractedFields: null,
          };
        }
        throw s3Error;
      }
      
      const ocrJob = await OcrService.processReceiptSync(receiptId);
      ocrJobId = (ocrJob._id as mongoose.Types.ObjectId).toString();
      
      if (ocrJob.status === 'COMPLETED' && ocrJob.result) {
        extractedFields = ocrJob.result;
        logger.info({ receiptId, ocrJobId }, 'OCR completed successfully');
      } else if (ocrJob.status === 'FAILED') {
        logger.warn({ receiptId, ocrJobId, error: ocrJob.error }, 'OCR processing failed');
      }
    } catch (error: any) {
      logger.error({
        receiptId,
        storageKey: receipt.storageKey,
        error: error.message,
        stack: error.stack,
      }, 'OCR processing error');
      // Don't fail the confirm upload if OCR fails - receipt is still uploaded
    }
    
    // Return receipt with OCR job info
    const receiptWithOcr = await Receipt.findById(receiptId)
      .populate('ocrJobId')
      .exec();
    
    return {
      receipt: receiptWithOcr || receipt,
      ocrJobId: ocrJobId || '',
      extractedFields,
    };
  }

  static async getReceipt(
    id: string,
    requestingUserId: string,
    requestingUserRole: string
  ): Promise<IReceipt | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }

    const receipt = await Receipt.findById(id).populate({
      path: 'expenseId',
      populate: { path: 'reportId' },
    });

    if (!receipt) {
      return null;
    }

    const expense = receipt.expenseId as any;
    const report = expense.reportId as any;

    // Check access
    if (
      report.userId.toString() !== requestingUserId &&
      requestingUserRole !== 'ADMIN' &&
      requestingUserRole !== 'BUSINESS_HEAD'
    ) {
      throw new Error('Access denied');
    }

    // Generate signed URL for the receipt (valid for 7 days)
    // This is REQUIRED - S3 buckets are private and require signed URLs
    let signedUrl: string;
    try {
      signedUrl = await getPresignedDownloadUrl(
        'receipts',
        receipt.storageKey,
        7 * 24 * 60 * 60 // 7 days
      );
      
      logger.debug({
        receiptId: id,
        storageKey: receipt.storageKey,
        signedUrlLength: signedUrl.length,
      }, 'Generated signed URL for receipt')
    } catch (error) {
      logger.error({
        receiptId: id,
        storageKey: receipt.storageKey,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }, 'Failed to generate signed URL for receipt');
      // Throw error - we cannot serve the receipt without a signed URL
      // The storageUrl will return 403 Forbidden from S3
      throw new Error(
        `Failed to generate signed URL for receipt. ` +
        `S3 bucket is private and requires signed URLs for access. ` +
        `Please check AWS credentials and S3 configuration. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Convert Mongoose document to plain object and add signedUrl
    // This ensures signedUrl is included in JSON response
    const receiptObj = receipt.toObject() as any;
    receiptObj.signedUrl = signedUrl;
    
    return receiptObj;
  }
}


import { randomUUID } from 'crypto';

import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { Receipt, IReceipt } from '../models/Receipt';
import { User } from '../models/User';
// import { ExpenseReport } from '../models/ExpenseReport'; // Unused - accessed via populate
import { UploadIntentDto } from '../utils/dtoTypes';
import { getPresignedUploadUrl, getObjectUrl, getPresignedDownloadUrl, uploadFileToS3 } from '../utils/s3';



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

  /**
   * Upload file directly to S3 via backend (bypasses CORS)
   * Uses file path for streaming upload (memory efficient)
   */
  static async uploadFile(
    receiptId: string,
    userId: string,
    filePath: string,
    mimeType: string
  ): Promise<void> {
    const fs = await import('fs');
    
    const receipt = await Receipt.findById(receiptId).populate({
      path: 'expenseId',
      populate: { path: 'reportId' },
    });

    if (!receipt) {
      // Clean up temp file if receipt not found
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw new Error('Receipt not found');
    }

    // Check access via report
    const expense = receipt.expenseId as any;
    const report = expense.reportId as any;

    if (report && report.userId.toString() !== userId) {
      // Clean up temp file on access denied
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw new Error('Access denied');
    }

    try {
      // Upload file to S3 using streaming (memory efficient)
      const fileSize = await uploadFileToS3('receipts', receipt.storageKey, filePath, mimeType);

      // Update receipt with file size
      receipt.sizeBytes = fileSize;
      await receipt.save();

      logger.info({
        receiptId,
        storageKey: receipt.storageKey,
      }, 'Upload success');
    } finally {
      // Always delete temp file after upload (success or failure)
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (deleteError) {
          // Ignore delete errors - file may have been deleted already
        }
      }
    }
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

    // Small delay to ensure S3 upload has fully propagated
    // S3 eventual consistency can cause issues if we try to read immediately
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Generate signed URL for the receipt (valid for 7 days)
    let signedUrl: string;
    try {
      signedUrl = await getPresignedDownloadUrl(
        'receipts',
        receipt.storageKey,
        7 * 24 * 60 * 60 // 7 days
      );
    } catch (error) {
      logger.error({
        receiptId,
        storageKey: receipt.storageKey,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to generate signed URL for receipt');
      // Don't fail the confirm - signed URL can be generated later when needed
      signedUrl = '';
    }

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
        signedUrl: signedUrl || '',
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
    }
    
    // Add signedUrl to receipt object for response
    const receiptObj = receipt.toObject ? receipt.toObject() : receipt;
    if (signedUrl) {
      (receiptObj as any).signedUrl = signedUrl;
    }

    // Enqueue OCR job (non-blocking)
    let ocrJobId: string | null = null;
    
    try {
      // Verify file exists in S3 before queuing OCR
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const { s3Client, getS3Bucket } = await import('../config/aws');
      const bucket = getS3Bucket('receipts');
      
      try {
        const headCommand = new HeadObjectCommand({
          Bucket: bucket,
          Key: receipt.storageKey,
        });
        await s3Client.send(headCommand);
      } catch (s3Error: any) {
        if (s3Error.name === 'NotFound' || s3Error.$metadata?.httpStatusCode === 404) {
          logger.error({
            receiptId,
            storageKey: receipt.storageKey,
          }, 'Receipt not found in S3 - OCR will be skipped.');
          // Don't throw - allow the confirm to succeed, OCR can be retried later
          return {
            receipt,
            ocrJobId: '',
            extractedFields: null,
          };
        }
        throw s3Error;
      }
      
      // Enqueue OCR job (non-blocking)
      ocrJobId = await OcrService.enqueueOcrJob(receiptId);
      logger.info({ receiptId }, 'OCR queued');
    } catch (error: any) {
      logger.error({
        receiptId,
        error: error.message,
      }, 'OCR queue error');
      // Don't fail the confirm upload if OCR queue fails - receipt is still uploaded
    }
    
    // Return receipt with OCR job info
    // Refresh receipt to ensure ocrJobId is populated
    const receiptWithOcr = await Receipt.findById(receiptId)
      .populate('ocrJobId')
      .populate({
        path: 'expenseId',
        populate: { path: 'reportId' },
      })
      .exec();
    
    if (!receiptWithOcr) {
      logger.error({ receiptId }, 'Receipt not found');
      throw new Error('Receipt not found');
    }
    
    // Ensure receipt has signedUrl if it was generated
    const finalReceiptObj = (receiptWithOcr as any).toObject ? (receiptWithOcr as any).toObject() : receiptWithOcr;
    if (signedUrl && !(finalReceiptObj as any).signedUrl) {
      (finalReceiptObj as any).signedUrl = signedUrl;
    }
    
    // Ensure ocrJobId is included in the response
    if (ocrJobId) {
      if ((finalReceiptObj as any).ocrJobId && typeof (finalReceiptObj as any).ocrJobId === 'object') {
        (finalReceiptObj as any).ocrJobId = (finalReceiptObj as any).ocrJobId._id?.toString() || (finalReceiptObj as any).ocrJobId.id?.toString() || ocrJobId;
      } else if (!(finalReceiptObj as any).ocrJobId) {
        (finalReceiptObj as any).ocrJobId = ocrJobId;
      }
    }
    
    return {
      receipt: finalReceiptObj,
      ocrJobId: ocrJobId || '',
      extractedFields: null, // OCR is queued, results will be available later
    };
  }

  static async getReceipt(
    id: string,
    requestingUserId: string,
    requestingUserRole: string
  ): Promise<IReceipt | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      logger.warn({ receiptId: id }, 'Invalid receipt ID format');
      throw new Error('Invalid receipt ID format');
    }

    const receipt = await Receipt.findById(id)
      .populate({
        path: 'expenseId',
        populate: { path: 'reportId' },
      })
      .populate('ocrJobId')
      .exec();

    if (!receipt) {
      logger.warn({ receiptId: id }, 'Receipt not found');
      throw new Error('Receipt not found');
    }

    // Check access - only if receipt has an expense with a report
    if (receipt.expenseId) {
      const expense = receipt.expenseId as any;
      const report = expense.reportId as any;

      if (report) {
        // Check access via report
        if (
          report.userId.toString() !== requestingUserId &&
          requestingUserRole !== 'ADMIN' &&
          requestingUserRole !== 'BUSINESS_HEAD'
        ) {
          logger.warn({
            receiptId: id,
            requestingUserId,
            reportUserId: report.userId.toString(),
          }, 'Access denied to receipt');
          throw new Error('Access denied');
        }
      }
    } else {
      // Receipt without expense - check if user has access (e.g., they uploaded it)
      // For now, allow access if user is authenticated
      logger.debug({ receiptId: id }, 'Receipt has no expenseId, allowing access for authenticated user');
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


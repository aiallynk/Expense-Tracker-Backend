import { Receipt, IReceipt } from '../models/Receipt';
import { Expense } from '../models/Expense';
import { User } from '../models/User';
// import { ExpenseReport } from '../models/ExpenseReport'; // Unused - accessed via populate
import { UploadIntentDto } from '../utils/dtoTypes';
import { getPresignedUploadUrl, getObjectUrl, getPresignedDownloadUrl } from '../utils/s3';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { OcrService } from './ocr.service';
import { logger } from '../utils/logger';

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
      sizeBytes: data.sizeBytes,
    });

    const saved = await receipt.save();

    // Link receipt to expense if it's the primary one
    if (!expense.receiptPrimaryId) {
      expense.receiptPrimaryId = saved._id as mongoose.Types.ObjectId;
      await expense.save();
    }

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

    const expense = receipt.expenseId as any;
    const report = expense.reportId as any;

    if (report.userId.toString() !== userId) {
      throw new Error('Access denied');
    }

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
      logger.info('Receipt URL stored in user collection', {
        userId,
        receiptId,
        storageUrl: receipt.storageUrl,
      });
    }

    // Enqueue OCR job (this starts processing immediately)
    const ocrJob = await OcrService.enqueueOcrJob(receiptId);
    
    // Return receipt with OCR job info
    const receiptWithOcr = await Receipt.findById(receiptId)
      .populate('ocrJobId')
      .exec();
    
    return {
      receipt: receiptWithOcr || receipt,
      ocrJobId: (ocrJob._id as mongoose.Types.ObjectId).toString(),
      // Note: extractedFields will be available after OCR completes
      // Client should poll the OCR job endpoint to get results
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
      
      logger.debug('Generated signed URL for receipt', {
        receiptId: id,
        storageKey: receipt.storageKey,
        signedUrlLength: signedUrl.length,
      });
    } catch (error) {
      logger.error('Failed to generate signed URL for receipt', {
        receiptId: id,
        storageKey: receipt.storageKey,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
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


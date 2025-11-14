import { Receipt, IReceipt } from '../models/Receipt';
import { Expense } from '../models/Expense';
// import { ExpenseReport } from '../models/ExpenseReport'; // Unused - accessed via populate
import { UploadIntentDto } from '../utils/dtoTypes';
import { getPresignedUploadUrl, getObjectUrl } from '../utils/s3';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { OcrService } from './ocr.service';

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

    // Generate storage key
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
  ): Promise<IReceipt> {
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

    // Enqueue OCR job
    await OcrService.enqueueOcrJob(receiptId);

    return receipt;
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

    return receipt;
  }
}


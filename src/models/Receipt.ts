import mongoose, { Document, Schema } from 'mongoose';

import { ReceiptStatus, ReceiptFailureReason } from '../utils/enums';

export interface IReceipt extends Document {
  expenseId?: mongoose.Types.ObjectId;
  storageKey: string;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailUrl?: string;
  ocrJobId?: mongoose.Types.ObjectId;
  parsedData?: Record<string, any>;
  uploadConfirmed: boolean;
  status: ReceiptStatus;
  failureReason?: ReceiptFailureReason;
  uploadTimeMs?: number;
  ocrTimeMs?: number;
  queueWaitTimeMs?: number;
  openaiTimeMs?: number;
  totalPipelineMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

const receiptSchema = new Schema<IReceipt>(
  {
    expenseId: {
      type: Schema.Types.ObjectId,
      ref: 'Expense',
    },
    storageKey: {
      type: String,
      required: true,
    },
    storageUrl: {
      type: String,
      required: true,
    },
    mimeType: {
      type: String,
      required: true,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 0,
    },
    thumbnailUrl: {
      type: String,
    },
    ocrJobId: {
      type: Schema.Types.ObjectId,
      ref: 'OcrJob',
    },
    parsedData: {
      type: Schema.Types.Mixed,
    },
    uploadConfirmed: {
      type: Boolean,
      default: false,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(ReceiptStatus),
      default: ReceiptStatus.PENDING,
      required: true,
    },
    failureReason: {
      type: String,
      enum: Object.values(ReceiptFailureReason),
    },
    uploadTimeMs: {
      type: Number,
      min: 0,
    },
    ocrTimeMs: {
      type: Number,
      min: 0,
    },
    queueWaitTimeMs: {
      type: Number,
      min: 0,
    },
    openaiTimeMs: {
      type: Number,
      min: 0,
    },
    totalPipelineMs: {
      type: Number,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
receiptSchema.index({ expenseId: 1 });
receiptSchema.index({ ocrJobId: 1 });
receiptSchema.index({ status: 1 });

export const Receipt = mongoose.model<IReceipt>('Receipt', receiptSchema);


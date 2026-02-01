import mongoose, { Document, Schema } from 'mongoose';

import { BatchStatus } from '../utils/enums';

export interface IBatch extends Document {
  batchId: string;
  reportId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  totalReceipts: number;
  completedReceipts: number;
  failedReceipts: number;
  status: BatchStatus;
  receiptIds: mongoose.Types.ObjectId[];
  expenseIds: mongoose.Types.ObjectId[];
  ocrJobIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const batchSchema = new Schema<IBatch>(
  {
    batchId: {
      type: String,
      required: true,
      unique: true,
    },
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'ExpenseReport',
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    totalReceipts: {
      type: Number,
      required: true,
      default: 0,
    },
    completedReceipts: {
      type: Number,
      required: true,
      default: 0,
    },
    failedReceipts: {
      type: Number,
      required: true,
      default: 0,
    },
    status: {
      type: String,
      enum: Object.values(BatchStatus),
      default: BatchStatus.UPLOADING,
      required: true,
    },
    receiptIds: [{
      type: Schema.Types.ObjectId,
      ref: 'Receipt',
    }],
    expenseIds: [{
      type: Schema.Types.ObjectId,
      ref: 'Expense',
    }],
    ocrJobIds: [{
      type: String,
    }],
  },
  {
    timestamps: true,
  }
);

batchSchema.index({ batchId: 1 });
batchSchema.index({ userId: 1, createdAt: -1 });

export const Batch = mongoose.model<IBatch>('Batch', batchSchema);

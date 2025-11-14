import mongoose, { Document, Schema } from 'mongoose';

export interface IReceipt extends Document {
  expenseId: mongoose.Types.ObjectId;
  storageKey: string;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailUrl?: string;
  ocrJobId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const receiptSchema = new Schema<IReceipt>(
  {
    expenseId: {
      type: Schema.Types.ObjectId,
      ref: 'Expense',
      required: true,
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
  },
  {
    timestamps: true,
  }
);

// Indexes
receiptSchema.index({ expenseId: 1 });
receiptSchema.index({ ocrJobId: 1 });

export const Receipt = mongoose.model<IReceipt>('Receipt', receiptSchema);


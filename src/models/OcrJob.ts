import mongoose, { Document, Schema } from 'mongoose';

import { OcrJobStatus } from '../utils/enums';

export interface IOcrJob extends Document {
  receiptId: mongoose.Types.ObjectId;
  status: OcrJobStatus;
  result?: Record<string, any>;
  error?: string;
  attempts: number;
  provider?: string;
  resultJson?: Record<string, any>;
  errorJson?: Record<string, any>;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ocrJobSchema = new Schema<IOcrJob>(
  {
    receiptId: {
      type: Schema.Types.ObjectId,
      ref: 'Receipt',
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(OcrJobStatus),
      default: OcrJobStatus.QUEUED,
      required: true,
    },
    result: {
      type: Schema.Types.Mixed,
    },
    error: {
      type: String,
    },
    attempts: {
      type: Number,
      default: 0,
      required: true,
    },
    provider: {
      type: String,
      default: 'TOGETHER_AI',
    },
    resultJson: {
      type: Schema.Types.Mixed,
    },
    errorJson: {
      type: Schema.Types.Mixed,
    },
    completedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
ocrJobSchema.index({ receiptId: 1 });
ocrJobSchema.index({ status: 1, createdAt: 1 });

export const OcrJob = mongoose.model<IOcrJob>('OcrJob', ocrJobSchema);


import mongoose, { Document, Schema } from 'mongoose';
import { OcrJobStatus } from '../utils/enums';

export interface IOcrJob extends Document {
  status: OcrJobStatus;
  provider: string;
  receiptId: mongoose.Types.ObjectId;
  resultJson?: Record<string, any>;
  errorJson?: Record<string, any>;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ocrJobSchema = new Schema<IOcrJob>(
  {
    status: {
      type: String,
      enum: Object.values(OcrJobStatus),
      default: OcrJobStatus.QUEUED,
      required: true,
    },
    provider: {
      type: String,
      default: 'OPENAI_VISION',
    },
    receiptId: {
      type: Schema.Types.ObjectId,
      ref: 'Receipt',
      required: true,
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


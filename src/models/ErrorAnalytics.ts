import mongoose, { Document, Schema } from 'mongoose';

export interface IErrorAnalytics extends Document {
  bucketStart: Date;
  bucketEnd: Date;
  path: string;
  statusCode: number;
  companyId?: mongoose.Types.ObjectId;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const errorAnalyticsSchema = new Schema<IErrorAnalytics>(
  {
    bucketStart: { type: Date, required: true },
    bucketEnd: { type: Date, required: true },
    path: { type: String, required: true, trim: true },
    statusCode: { type: Number, required: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company' },
    errorCount: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    timestamps: true,
  }
);

errorAnalyticsSchema.index({ bucketStart: -1 });
errorAnalyticsSchema.index({ statusCode: 1, bucketStart: -1 });
errorAnalyticsSchema.index({ companyId: 1, bucketStart: -1 });
errorAnalyticsSchema.index(
  { bucketStart: 1, bucketEnd: 1, path: 1, statusCode: 1, companyId: 1 },
  { unique: true }
);

export const ErrorAnalytics = mongoose.model<IErrorAnalytics>('ErrorAnalytics', errorAnalyticsSchema);


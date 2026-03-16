import mongoose, { Document, Schema } from 'mongoose';

export type ApiStatusGroup = '2xx' | '4xx' | '5xx' | 'other';

export interface IApiAnalytics extends Document {
  bucketStart: Date;
  bucketEnd: Date;
  method: string;
  path: string;
  statusGroup: ApiStatusGroup;
  companyId?: mongoose.Types.ObjectId;
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  createdAt: Date;
  updatedAt: Date;
}

const apiAnalyticsSchema = new Schema<IApiAnalytics>(
  {
    bucketStart: { type: Date, required: true },
    bucketEnd: { type: Date, required: true },
    method: { type: String, required: true, trim: true },
    path: { type: String, required: true, trim: true },
    statusGroup: {
      type: String,
      enum: ['2xx', '4xx', '5xx', 'other'],
      required: true,
    },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company' },
    requestCount: { type: Number, required: true, default: 0, min: 0 },
    errorCount: { type: Number, required: true, default: 0, min: 0 },
    avgResponseTime: { type: Number, required: true, default: 0, min: 0 },
    p95ResponseTime: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    timestamps: true,
  }
);

apiAnalyticsSchema.index({ bucketStart: -1 });
apiAnalyticsSchema.index({ path: 1, bucketStart: -1 });
apiAnalyticsSchema.index({ companyId: 1, bucketStart: -1 });
apiAnalyticsSchema.index(
  { bucketStart: 1, bucketEnd: 1, method: 1, path: 1, statusGroup: 1, companyId: 1 },
  { unique: true }
);

export const ApiAnalytics = mongoose.model<IApiAnalytics>('ApiAnalytics', apiAnalyticsSchema);


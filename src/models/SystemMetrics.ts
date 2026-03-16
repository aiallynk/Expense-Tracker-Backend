import mongoose, { Document, Schema } from 'mongoose';

export interface ISystemMetrics extends Document {
  bucketStart: Date;
  bucketEnd: Date;
  apiRequests: number;
  errorRequests: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  ocrQueueDepth: number;
  dbConnected: boolean;
  redisConnected: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const systemMetricsSchema = new Schema<ISystemMetrics>(
  {
    bucketStart: { type: Date, required: true },
    bucketEnd: { type: Date, required: true },
    apiRequests: { type: Number, required: true, default: 0, min: 0 },
    errorRequests: { type: Number, required: true, default: 0, min: 0 },
    avgResponseTime: { type: Number, required: true, default: 0, min: 0 },
    p95ResponseTime: { type: Number, required: true, default: 0, min: 0 },
    ocrQueueDepth: { type: Number, required: true, default: 0, min: 0 },
    dbConnected: { type: Boolean, required: true, default: false },
    redisConnected: { type: Boolean, required: true, default: false },
  },
  {
    timestamps: true,
  }
);

systemMetricsSchema.index({ bucketStart: -1 });
systemMetricsSchema.index({ bucketStart: 1, bucketEnd: 1 }, { unique: true });

export const SystemMetrics = mongoose.model<ISystemMetrics>('SystemMetrics', systemMetricsSchema);


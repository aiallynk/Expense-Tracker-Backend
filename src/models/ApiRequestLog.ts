import mongoose, { Document, Schema } from 'mongoose';

export interface IApiRequestLog extends Document {
  method: string;
  path: string;
  statusCode: number;
  responseTime: number; // in milliseconds
  userId?: mongoose.Types.ObjectId;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const apiRequestLogSchema = new Schema<IApiRequestLog>(
  {
    method: {
      type: String,
      required: true,
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    },
    path: {
      type: String,
      required: true,
      // Index created by compound indexes below, no need for explicit index: true
    },
    statusCode: {
      type: Number,
      required: true,
      // Index created by compound indexes below, no need for explicit index: true
    },
    responseTime: {
      type: Number,
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      // No explicit index needed (not used in compound indexes)
    },
    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes for efficient queries
apiRequestLogSchema.index({ createdAt: -1 });
apiRequestLogSchema.index({ path: 1, createdAt: -1 });
apiRequestLogSchema.index({ statusCode: 1, createdAt: -1 });
apiRequestLogSchema.index({ method: 1, path: 1 });

// TTL index to auto-delete logs older than 30 days
apiRequestLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const ApiRequestLog = mongoose.model<IApiRequestLog>('ApiRequestLog', apiRequestLogSchema);


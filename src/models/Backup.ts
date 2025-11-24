import mongoose, { Document, Schema } from 'mongoose';

export interface IBackup extends Document {
  type: 'automatic' | 'manual';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  size: number; // in bytes
  storageKey?: string; // S3 key if stored in S3
  storageUrl?: string; // S3 URL if stored in S3
  metadata?: {
    collections?: string[];
    recordCount?: number;
    version?: string;
  };
  error?: string;
  createdBy?: mongoose.Types.ObjectId; // User who created (for manual backups)
  createdAt: Date;
  completedAt?: Date;
}

const backupSchema = new Schema<IBackup>(
  {
    type: {
      type: String,
      enum: ['automatic', 'manual'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      required: true,
    },
    size: {
      type: Number,
      default: 0,
    },
    storageKey: {
      type: String,
    },
    storageUrl: {
      type: String,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    error: {
      type: String,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    completedAt: {
      type: Date,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes
backupSchema.index({ createdAt: -1 });
backupSchema.index({ status: 1 });
backupSchema.index({ type: 1 });

export const Backup = mongoose.model<IBackup>('Backup', backupSchema);


import mongoose, { Document, Schema } from 'mongoose';

export enum BackupType {
  FULL = 'FULL',
  COMPANY = 'COMPANY',
}

export enum BackupStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface IBackupManifest {
  backupId: string;
  backupType: BackupType;
  companyId?: string;
  companyName?: string;
  createdAt: string;
  createdBy?: string;
  createdByEmail?: string;
  recordCounts: {
    companies?: number;
    users?: number;
    reports?: number;
    expenses?: number;
    ocrJobs?: number;
    receipts?: number;
    departments?: number;
    projects?: number;
    costCentres?: number;
  };
  appVersion: string;
  databaseVersion?: string;
}

export interface IBackup extends Document {
  backupType: BackupType; // FULL or COMPANY
  companyId?: mongoose.Types.ObjectId; // Only for COMPANY backups
  backupName?: string; // Optional user-provided name
  status: BackupStatus;
  size: number; // in bytes
  storageKey?: string; // S3 key (e.g., full-backups/backup_2024-01-09_14-30-00.zip)
  storageUrl?: string; // S3 URL
  manifest?: IBackupManifest; // Backup manifest with metadata
  metadata?: {
    collections?: string[];
    recordCount?: number;
    version?: string;
  };
  error?: string;
  createdBy?: mongoose.Types.ObjectId; // User who created
  createdAt: Date;
  completedAt?: Date;
}

const backupSchema = new Schema<IBackup>(
  {
    backupType: {
      type: String,
      enum: Object.values(BackupType),
      required: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: function(this: IBackup) {
        return this.backupType === BackupType.COMPANY;
      },
    },
    backupName: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    status: {
      type: String,
      enum: Object.values(BackupStatus),
      default: BackupStatus.PENDING,
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
    manifest: {
      type: Schema.Types.Mixed,
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
backupSchema.index({ backupType: 1 });
backupSchema.index({ companyId: 1 });
backupSchema.index({ createdBy: 1 });

export const Backup = mongoose.model<IBackup>('Backup', backupSchema);


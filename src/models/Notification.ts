import mongoose, { Document, Schema } from 'mongoose';

export enum NotificationType {
  REPORT_SUBMITTED = 'report_submitted',
  REPORT_APPROVED = 'report_approved',
  REPORT_REJECTED = 'report_rejected',
  REPORT_CHANGES_REQUESTED = 'report_changes_requested',
  EXPENSE_CREATED = 'expense_created',
  EXPENSE_APPROVED = 'expense_approved',
  EXPENSE_REJECTED = 'expense_rejected',
  EXPENSE_CHANGES_REQUESTED = 'expense_changes_requested',
  USER_CREATED = 'user_created',
  USER_UPDATED = 'user_updated',
  USER_DELETED = 'user_deleted',
  DEPARTMENT_UPDATED = 'department_updated',
  ROLE_CHANGED = 'role_changed',
  SETTINGS_UPDATED = 'settings_updated',
}

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId; // User/company admin who should receive this notification
  companyId?: mongoose.Types.ObjectId; // Company this notification belongs to
  type: NotificationType;
  title: string;
  description: string;
  link?: string; // Optional link to related entity
  read: boolean;
  readAt?: Date;
  metadata?: Record<string, any>; // Additional data (e.g., reportId, userId, etc.)
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      // Index created by compound index below, no need for explicit index: true
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      // Index created by compound index below, no need for explicit index: true
    },
    type: {
      type: String,
      enum: Object.values(NotificationType),
      required: true,
      // No explicit index needed
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    link: {
      type: String,
    },
    read: {
      type: Boolean,
      default: false,
      // Index created by compound index below, no need for explicit index: true
    },
    readAt: {
      type: Date,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ companyId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);


import mongoose, { Document, Schema } from 'mongoose';

import { BroadcastTargetType } from '../utils/enums';

export enum NotificationBroadcastType {
  INFO = 'INFO',
  WARNING = 'WARNING',
  MAINTENANCE = 'MAINTENANCE',
  CRITICAL = 'CRITICAL',
}

export enum NotificationBroadcastChannel {
  IN_APP = 'IN_APP',
  EMAIL = 'EMAIL',
  PUSH = 'PUSH',
}

export enum NotificationBroadcastStatus {
  SCHEDULED = 'SCHEDULED',
  SENDING = 'SENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export interface INotificationBroadcast extends Document {
  title: string;
  message: string;
  type: NotificationBroadcastType;
  targetType: BroadcastTargetType; // ALL_USERS (all companies) | COMPANY (single company)
  companyId?: mongoose.Types.ObjectId;
  channels: NotificationBroadcastChannel[];
  scheduledAt?: Date;
  status: NotificationBroadcastStatus;
  createdBy: mongoose.Types.ObjectId;
  sentAt?: Date;
  delivery?: {
    inApp?: { created: number };
    email?: { attempted: number; sent: number; failed: number };
    push?: { topic?: string; messageId?: string };
  };
  lastError?: string;
  // Simple distributed lock for scheduled processing (multi-instance safe)
  lockedAt?: Date;
  lockOwner?: string;
  createdAt: Date;
  updatedAt: Date;
}

const notificationBroadcastSchema = new Schema<INotificationBroadcast>(
  {
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: Object.values(NotificationBroadcastType),
      required: true,
    },
    targetType: {
      type: String,
      enum: Object.values(BroadcastTargetType),
      required: true,
    },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company' },
    channels: [
      {
        type: String,
        enum: Object.values(NotificationBroadcastChannel),
        required: true,
      },
    ],
    scheduledAt: { type: Date },
    status: {
      type: String,
      enum: Object.values(NotificationBroadcastStatus),
      required: true,
      default: NotificationBroadcastStatus.SENT,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sentAt: { type: Date },
    delivery: { type: Schema.Types.Mixed },
    lastError: { type: String },
    lockedAt: { type: Date },
    lockOwner: { type: String },
  },
  { timestamps: true }
);

notificationBroadcastSchema.index({ status: 1, scheduledAt: 1 });
notificationBroadcastSchema.index({ createdAt: -1 });
notificationBroadcastSchema.index({ targetType: 1, companyId: 1 });

export const NotificationBroadcast = mongoose.model<INotificationBroadcast>(
  'NotificationBroadcast',
  notificationBroadcastSchema
);



import mongoose, { Document, Schema } from 'mongoose';

import { NotificationPlatform } from '../utils/enums';

export interface INotificationToken extends Document {
  userId: mongoose.Types.ObjectId;
  token: string;
  platform: NotificationPlatform;
  fcmToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

const notificationTokenSchema = new Schema<INotificationToken>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    token: {
      type: String,
      required: true,
    },
    platform: {
      type: String,
      enum: Object.values(NotificationPlatform),
      required: true,
    },
    fcmToken: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
notificationTokenSchema.index({ userId: 1 });
notificationTokenSchema.index({ token: 1 }, { unique: true });
notificationTokenSchema.index({ fcmToken: 1 }, { unique: true, sparse: true });
notificationTokenSchema.index({ userId: 1, platform: 1 });

export const NotificationToken = mongoose.model<INotificationToken>(
  'NotificationToken',
  notificationTokenSchema
);


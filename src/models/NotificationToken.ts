import mongoose, { Document, Schema } from 'mongoose';
import { NotificationPlatform } from '../utils/enums';

export interface INotificationToken extends Document {
  userId: mongoose.Types.ObjectId;
  fcmToken: string;
  platform: NotificationPlatform;
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
    fcmToken: {
      type: String,
      required: true,
    },
    platform: {
      type: String,
      enum: Object.values(NotificationPlatform),
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
notificationTokenSchema.index({ userId: 1 });
notificationTokenSchema.index({ fcmToken: 1 }, { unique: true });
notificationTokenSchema.index({ userId: 1, platform: 1 });

export const NotificationToken = mongoose.model<INotificationToken>(
  'NotificationToken',
  notificationTokenSchema
);


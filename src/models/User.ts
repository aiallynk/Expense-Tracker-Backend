import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { UserRole, UserStatus } from '../utils/enums';

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  name?: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt?: Date;
  receiptUrls?: Array<{
    receiptId: mongoose.Types.ObjectId;
    storageUrl: string;
    signedUrl?: string;
    signedUrlExpiresAt?: Date;
    uploadedAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      trim: true,
    },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.EMPLOYEE,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(UserStatus),
      default: UserStatus.ACTIVE,
      required: true,
    },
    lastLoginAt: {
      type: Date,
    },
    receiptUrls: [
      {
        receiptId: {
          type: Schema.Types.ObjectId,
          ref: 'Receipt',
          required: true,
        },
        storageUrl: {
          type: String,
          required: true,
        },
        signedUrl: {
          type: String,
        },
        signedUrlExpiresAt: {
          type: Date,
        },
        uploadedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Indexes
// Note: email index is automatically created by unique: true in schema
userSchema.index({ role: 1, status: 1 });

// Methods
userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

export const User = mongoose.model<IUser>('User', userSchema);


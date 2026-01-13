import bcrypt from 'bcrypt';
import mongoose, { Document, Schema } from 'mongoose';

import { UserRole, UserStatus } from '../utils/enums';

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  name?: string;
  phone?: string;
  employeeId?: string; // Unique employee ID (e.g., ABC001)
  role: UserRole;
  companyId?: mongoose.Types.ObjectId;
  managerId?: mongoose.Types.ObjectId;
  departmentId?: mongoose.Types.ObjectId;
  roles?: mongoose.Types.ObjectId[];
  status: UserStatus;
  lastLoginAt?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
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
    phone: {
      type: String,
      trim: true,
    },
    employeeId: {
      type: String,
      trim: true,
      uppercase: true,
      // No index options here - index is created explicitly below with sparse: true
    },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.EMPLOYEE,
      required: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
    },
    managerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    departmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Department',
    },
    roles: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Role',
      },
    ],
    status: {
      type: String,
      enum: Object.values(UserStatus),
      default: UserStatus.ACTIVE,
      required: true,
    },
    lastLoginAt: {
      type: Date,
    },
    passwordResetToken: {
      type: String,
    },
    passwordResetExpires: {
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
// employeeId: sparse unique index (allows null but enforces uniqueness when present)
userSchema.index({ employeeId: 1 }, { unique: true, sparse: true });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ companyId: 1 });
userSchema.index({ managerId: 1 });
userSchema.index({ departmentId: 1 });

// Methods
userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

export const User = mongoose.model<IUser>('User', userSchema);


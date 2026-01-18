import bcrypt from 'bcrypt';
import mongoose, { Document, Schema } from 'mongoose';

export enum CompanyAdminStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

export interface ICompanyAdmin extends Document {
  email: string;
  passwordHash: string;
  name: string;
  phone?: string;
  profileImage?: string; // S3 URL for profile image
  companyId: mongoose.Types.ObjectId;
  status: CompanyAdminStatus;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const companyAdminSchema = new Schema<ICompanyAdmin>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      // Index created by unique: true, no need for explicit index: true
    },
    passwordHash: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    profileImage: {
      type: String,
      default: null,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      // Index created explicitly below, no need for index: true
    },
    status: {
      type: String,
      enum: Object.values(CompanyAdminStatus),
      default: CompanyAdminStatus.ACTIVE,
      required: true,
    },
    lastLoginAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
companyAdminSchema.index({ companyId: 1, email: 1 });
companyAdminSchema.index({ companyId: 1, status: 1 });

// Method to compare password
companyAdminSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// Pre-save hook to ensure email is lowercase
companyAdminSchema.pre('save', function (next) {
  if (this.isModified('email')) {
    this.email = this.email.toLowerCase().trim();
  }
  next();
});

export const CompanyAdmin = mongoose.model<ICompanyAdmin>('CompanyAdmin', companyAdminSchema);


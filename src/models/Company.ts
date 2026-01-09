import mongoose, { Document, Schema } from 'mongoose';

export enum CompanyType {
  FINANCE = 'Finance',
  IT = 'IT',
  HEALTHCARE = 'Healthcare',
  RETAIL = 'Retail',
  MANUFACTURING = 'Manufacturing',
  CONSULTING = 'Consulting',
  EDUCATION = 'Education',
  OTHER = 'Other',
}

export enum CompanyStatus {
  ACTIVE = 'active',
  TRIAL = 'trial',
  SUSPENDED = 'suspended',
  INACTIVE = 'inactive',
}

export enum CompanyPlan {
  FREE = 'free',
  BASIC = 'basic',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

export interface ICompany extends Document {
  name: string;
  shortcut?: string; // Company shortcut code (e.g., "ABC" for "ABC Company")
  location?: string;
  type?: CompanyType;
  status: CompanyStatus;
  plan: CompanyPlan;
  domain?: string;
  // Branding fields
  logoUrl?: string; // URL to company logo (stored in S3) - Light mode logo
  logoStorageKey?: string; // S3 storage key for light mode logo
  darkLogoUrl?: string; // URL to company dark mode logo (stored in S3)
  darkLogoStorageKey?: string; // S3 storage key for dark mode logo
  createdAt: Date;
  updatedAt: Date;
}

const companySchema = new Schema<ICompany>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    shortcut: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 10,
    },
    location: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: Object.values(CompanyType),
      default: CompanyType.OTHER,
    },
    status: {
      type: String,
      enum: Object.values(CompanyStatus),
      default: CompanyStatus.ACTIVE,
      required: true,
    },
    plan: {
      type: String,
      enum: Object.values(CompanyPlan),
      default: CompanyPlan.BASIC,
      required: true,
    },
    domain: {
      type: String,
      trim: true,
      lowercase: true,
    },
    // Branding fields
    logoUrl: {
      type: String,
      trim: true,
    },
    logoStorageKey: {
      type: String,
      trim: true,
    },
    darkLogoUrl: {
      type: String,
      trim: true,
    },
    darkLogoStorageKey: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
companySchema.index({ name: 1 });
companySchema.index({ status: 1 });
companySchema.index({ type: 1 });
companySchema.index({ plan: 1 });

export const Company = mongoose.model<ICompany>('Company', companySchema);


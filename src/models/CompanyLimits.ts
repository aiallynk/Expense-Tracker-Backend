import mongoose, { Document, Schema } from 'mongoose';

export interface ICompanyLimits extends Document {
  companyId: mongoose.Types.ObjectId;
  maxExpenses: number;
  maxReports: number;
  limitsEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const companyLimitsSchema = new Schema<ICompanyLimits>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      unique: true,
    },
    maxExpenses: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    maxReports: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    limitsEnabled: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

companyLimitsSchema.index({ companyId: 1 }, { unique: true });
companyLimitsSchema.index({ limitsEnabled: 1 });

export const CompanyLimits = mongoose.model<ICompanyLimits>('CompanyLimits', companyLimitsSchema);


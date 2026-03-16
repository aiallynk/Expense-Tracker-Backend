import mongoose, { Document, Schema } from 'mongoose';

export interface ICompanyUsage extends Document {
  companyId: mongoose.Types.ObjectId;
  expensesUsed: number;
  reportsUsed: number;
  lastUpdated: Date;
}

const companyUsageSchema = new Schema<ICompanyUsage>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      unique: true,
    },
    expensesUsed: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    reportsUsed: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    lastUpdated: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

companyUsageSchema.index({ companyId: 1 }, { unique: true });
companyUsageSchema.index({ lastUpdated: -1 });

export const CompanyUsage = mongoose.model<ICompanyUsage>('CompanyUsage', companyUsageSchema);


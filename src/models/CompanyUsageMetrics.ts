import mongoose, { Document, Schema } from 'mongoose';

export interface ICompanyUsageMetrics extends Document {
  companyId: mongoose.Types.ObjectId;
  bucketStart: Date;
  bucketEnd: Date;
  expensesUsed: number;
  reportsUsed: number;
  maxExpenses: number;
  maxReports: number;
  expenseUsagePct: number;
  reportUsagePct: number;
  maxUsagePct: number;
  createdAt: Date;
  updatedAt: Date;
}

const companyUsageMetricsSchema = new Schema<ICompanyUsageMetrics>(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
    bucketStart: { type: Date, required: true },
    bucketEnd: { type: Date, required: true },
    expensesUsed: { type: Number, required: true, default: 0, min: 0 },
    reportsUsed: { type: Number, required: true, default: 0, min: 0 },
    maxExpenses: { type: Number, required: true, default: 0, min: 0 },
    maxReports: { type: Number, required: true, default: 0, min: 0 },
    expenseUsagePct: { type: Number, required: true, default: 0, min: 0 },
    reportUsagePct: { type: Number, required: true, default: 0, min: 0 },
    maxUsagePct: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    timestamps: true,
  }
);

companyUsageMetricsSchema.index({ bucketStart: -1 });
companyUsageMetricsSchema.index({ companyId: 1, bucketStart: -1 });
companyUsageMetricsSchema.index({ maxUsagePct: -1, bucketStart: -1 });
companyUsageMetricsSchema.index({ companyId: 1, bucketStart: 1, bucketEnd: 1 }, { unique: true });

export const CompanyUsageMetrics = mongoose.model<ICompanyUsageMetrics>(
  'CompanyUsageMetrics',
  companyUsageMetricsSchema
);


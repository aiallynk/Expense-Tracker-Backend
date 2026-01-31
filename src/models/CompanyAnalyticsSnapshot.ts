import mongoose, { Document, Schema } from 'mongoose';

/**
 * Single source of truth for company analytics.
 * Dashboards read ONLY from this snapshot; never from expenses/reports tables.
 * Updated by background worker on REPORT_APPROVED, REPORT_REJECTED, etc.
 */
export interface ICompanyAnalyticsSnapshot extends Document {
  companyId: mongoose.Types.ObjectId;
  period: string; // "month" | "all"
  periodKey: string; // "2025-01" for month, "all" for all-time
  totalReports: number;
  approvedReports: number;
  rejectedReports: number;
  totalExpenseAmount: number;
  approvedExpenseAmount: number;
  rejectedExpenseAmount: number;
  voucherUsedAmount: number;
  employeePaidAmount: number;
  categoryBreakdown: Record<string, number>; // categoryId -> amount (APPROVED expenses only)
  updatedAt: Date;
}

const companyAnalyticsSnapshotSchema = new Schema<ICompanyAnalyticsSnapshot>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    period: {
      type: String,
      required: true,
      enum: ['month', 'all'],
    },
    periodKey: {
      type: String,
      required: true,
      trim: true,
    },
    totalReports: {
      type: Number,
      default: 0,
      min: 0,
    },
    approvedReports: {
      type: Number,
      default: 0,
      min: 0,
    },
    rejectedReports: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalExpenseAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    approvedExpenseAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    rejectedExpenseAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    voucherUsedAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    employeePaidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    categoryBreakdown: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

companyAnalyticsSnapshotSchema.index(
  { companyId: 1, period: 1, periodKey: 1 },
  { unique: true }
);

export const CompanyAnalyticsSnapshot = mongoose.model<ICompanyAnalyticsSnapshot>(
  'CompanyAnalyticsSnapshot',
  companyAnalyticsSnapshotSchema
);

import mongoose, { Document, Schema } from 'mongoose';

export enum VoucherUsageStatus {
  APPLIED = 'APPLIED',
  REVERSED = 'REVERSED',
}

export interface IVoucherUsage extends Document {
  voucherId: mongoose.Types.ObjectId;
  reportId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  amountUsed: number;
  currency: string;
  appliedAt: Date;
  appliedBy: mongoose.Types.ObjectId;
  status: VoucherUsageStatus;
  reversedAt?: Date;
  reversedBy?: mongoose.Types.ObjectId;
  reversalReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const voucherUsageSchema = new Schema<IVoucherUsage>(
  {
    voucherId: {
      type: Schema.Types.ObjectId,
      ref: 'AdvanceCash',
      required: true,
    },
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'ExpenseReport',
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    amountUsed: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'INR',
      required: true,
      trim: true,
      uppercase: true,
    },
    appliedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    appliedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(VoucherUsageStatus),
      default: VoucherUsageStatus.APPLIED,
      required: true,
    },
    reversedAt: {
      type: Date,
    },
    reversedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    reversalReason: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// Unique constraint: One voucher per report
voucherUsageSchema.index({ voucherId: 1, reportId: 1 }, { unique: true });

// Indexes for queries
voucherUsageSchema.index({ voucherId: 1 }); // Voucher lookup
voucherUsageSchema.index({ voucherId: 1, createdAt: -1 }); // Usage history per voucher
voucherUsageSchema.index({ reportId: 1 }); // Report's voucher usage
voucherUsageSchema.index({ companyId: 1 }); // Company lookup
voucherUsageSchema.index({ companyId: 1, createdAt: -1 }); // Company-wide usage tracking

export const VoucherUsage = mongoose.model<IVoucherUsage>('VoucherUsage', voucherUsageSchema);

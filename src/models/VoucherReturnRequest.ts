import mongoose, { Document, Schema } from 'mongoose';

export enum VoucherReturnRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export interface IVoucherReturnRequest extends Document {
  voucherId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  returnAmount: number;
  currency: string;
  reason?: string;
  status: VoucherReturnRequestStatus;
  requestedAt: Date;
  requestedBy: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewerComment?: string;
  createdAt: Date;
  updatedAt: Date;
}

const voucherReturnRequestSchema = new Schema<IVoucherReturnRequest>(
  {
    voucherId: {
      type: Schema.Types.ObjectId,
      ref: 'AdvanceCash',
      required: true,
      index: true,
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
      index: true,
    },
    returnAmount: {
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
    reason: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(VoucherReturnRequestStatus),
      default: VoucherReturnRequestStatus.PENDING,
      required: true,
      index: true,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reviewedAt: {
      type: Date,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewerComment: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// Indexes for queries
voucherReturnRequestSchema.index({ voucherId: 1, status: 1 }); // Voucher return status
voucherReturnRequestSchema.index({ userId: 1, status: 1 }); // User's return requests
voucherReturnRequestSchema.index({ companyId: 1, status: 1, createdAt: -1 }); // Admin dashboard queries

export const VoucherReturnRequest = mongoose.model<IVoucherReturnRequest>(
  'VoucherReturnRequest',
  voucherReturnRequestSchema
);

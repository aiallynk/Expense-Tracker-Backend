import mongoose, { Document, Schema } from 'mongoose';

export enum AdvanceCashStatus {
  ACTIVE = 'ACTIVE',
  SETTLED = 'SETTLED',
}

export interface IAdvanceCash extends Document {
  companyId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  amount: number;
  balance: number;
  currency: string;
  projectId?: mongoose.Types.ObjectId;
  costCentreId?: mongoose.Types.ObjectId;
  status: AdvanceCashStatus;
  reportId?: mongoose.Types.ObjectId; // Track which report this voucher is assigned to (one voucher per report)
  usedAmount?: number; // Amount used from this voucher
  returnedAmount?: number; // Amount returned from this voucher
  returnedBy?: mongoose.Types.ObjectId; // Who returned the remaining amount
  returnedAt?: Date; // When the amount was returned
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const advanceCashSchema = new Schema<IAdvanceCash>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    balance: {
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
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
    },
    costCentreId: {
      type: Schema.Types.ObjectId,
      ref: 'CostCentre',
    },
    status: {
      type: String,
      enum: Object.values(AdvanceCashStatus),
      default: AdvanceCashStatus.ACTIVE,
      required: true,
      index: true,
    },
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'ExpenseReport',
      index: true,
    },
    usedAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnedAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    returnedAt: {
      type: Date,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

advanceCashSchema.index({ companyId: 1, employeeId: 1, status: 1, createdAt: 1 });
advanceCashSchema.index({ companyId: 1, status: 1 });

export const AdvanceCash = mongoose.model<IAdvanceCash>('AdvanceCash', advanceCashSchema);



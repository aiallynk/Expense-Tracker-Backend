import mongoose, { Document, Schema } from 'mongoose';

export enum AdvanceCashStatus {
  ACTIVE = 'ACTIVE',
  PARTIAL = 'PARTIAL',
  EXHAUSTED = 'EXHAUSTED',
  RETURNED = 'RETURNED',
  REIMBURSED = 'REIMBURSED', // Settlement done for report(s) that used this voucher
  SETTLED = 'SETTLED', // Keep for backward compatibility
}

export interface IAdvanceCash extends Document {
  companyId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  totalAmount: number; // Original issued amount
  remainingAmount: number; // Current available balance (replaces 'balance')
  usedAmount: number; // Sum of all usages
  currency: string;
  projectId?: mongoose.Types.ObjectId;
  costCentreId?: mongoose.Types.ObjectId;
  status: AdvanceCashStatus;
  voucherCode?: string; // User-facing identifier; mandatory for new vouchers (or auto-generated)
  expiry?: Date; // Optional expiry; vouchers past expiry are not selectable
  returnRequestId?: mongoose.Types.ObjectId; // Reference to return request if any
  returnedAmount?: number; // Amount returned from this voucher
  returnedBy?: mongoose.Types.ObjectId; // Who returned the remaining amount
  returnedAt?: Date; // When the amount was returned
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  // Legacy fields for backward compatibility
  amount?: number; // Maps to totalAmount
  balance?: number; // Maps to remainingAmount
  reportId?: mongoose.Types.ObjectId; // Deprecated - vouchers can be used across multiple reports
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
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    remainingAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    usedAmount: {
      type: Number,
      default: 0,
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
    voucherCode: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
    },
    expiry: {
      type: Date,
      index: true,
    },
    returnRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'VoucherReturnRequest',
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
    // Legacy fields for backward compatibility
    amount: {
      type: Number,
      min: 0,
    },
    balance: {
      type: Number,
      min: 0,
    },
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'ExpenseReport',
      index: true,
    },
  },
  { timestamps: true }
);

// Pre-save hook to sync legacy fields, enforce voucherCode, and calculate status
advanceCashSchema.pre('save', function (next) {
  // Sync legacy fields for backward compatibility
  if (this.totalAmount !== undefined && this.amount === undefined) {
    this.amount = this.totalAmount;
  }
  if (this.remainingAmount !== undefined && this.balance === undefined) {
    this.balance = this.remainingAmount;
  }
  
  // Enforce voucherCode: auto-generate if missing
  if (!this.voucherCode || this.voucherCode.trim() === '') {
    // Generate 5-8 digit code
    const digits = Math.floor(Math.random() * 4) + 5; // 5-8 digits
    const code = Math.floor(Math.random() * Math.pow(10, digits))
      .toString()
      .padStart(digits, '0');
    this.voucherCode = `VCH-${code}`;
  }
  
  // Defensive: EXHAUSTED or zero remaining => force remainingAmount and balance to 0
  if (this.status === AdvanceCashStatus.EXHAUSTED || this.remainingAmount === 0) {
    this.remainingAmount = 0;
    this.balance = 0;
  }
  if (this.remainingAmount !== undefined && this.balance === undefined) {
    this.balance = this.remainingAmount;
  }

  // Auto-calculate status based on remainingAmount
  if (this.remainingAmount !== undefined && this.totalAmount !== undefined) {
    if (this.status !== AdvanceCashStatus.RETURNED) {
      if (this.remainingAmount === 0) {
        this.status = AdvanceCashStatus.EXHAUSTED;
      } else if (this.remainingAmount < this.totalAmount) {
        this.status = AdvanceCashStatus.PARTIAL;
      } else if (this.remainingAmount === this.totalAmount) {
        this.status = AdvanceCashStatus.ACTIVE;
      }
    }
  }

  next();
});

advanceCashSchema.index({ companyId: 1, employeeId: 1, status: 1, createdAt: 1 });
advanceCashSchema.index({ companyId: 1, status: 1 });

export const AdvanceCash = mongoose.model<IAdvanceCash>('AdvanceCash', advanceCashSchema);



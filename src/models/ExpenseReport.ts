import mongoose, { Document, Schema } from 'mongoose';

import { ExpenseReportStatus } from '../utils/enums';

export interface IApprover {
  level: number;
  userId: mongoose.Types.ObjectId;
  role: string;
  decidedAt?: Date;
  action?: string;
  comment?: string;
  isAdditionalApproval?: boolean; // Flag to mark budget-triggered additional approvals
  approvalRuleId?: mongoose.Types.ObjectId; // Reference to the rule that triggered this approval
  triggerReason?: string; // Human-readable reason (e.g., "Report exceeds ₹50,000")
}

export interface IExpenseReport extends Document {
  userId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId;
  projectName?: string;
  costCentreId?: mongoose.Types.ObjectId;
  name: string;
  notes?: string;
  fromDate: Date;
  toDate: Date;
  status: ExpenseReportStatus;
  totalAmount: number;
  currency: string;
  approvers: IApprover[];
  submittedAt?: Date;
  approvedAt?: Date;
  rejectedAt?: Date;
  // Advance cash (report-level) - voucher-based
  advanceCashId?: mongoose.Types.ObjectId; // Legacy: first voucher; use appliedVouchers for 1-to-N
  advanceAppliedAmount?: number; // Legacy: amount from first voucher
  advanceCurrency?: string;
  advanceAppliedAt?: Date;
  voucherLockedAt?: Date;
  voucherLockedBy?: mongoose.Types.ObjectId;
  /** 1-to-N vouchers per report (plan §2). Company liability = sum of amountUsed. */
  appliedVouchers?: Array<{
    voucherId: mongoose.Types.ObjectId;
    voucherCode: string;
    amountUsed: number;
    currency: string;
  }>;
  // Settlement fields
  settlementStatus?: 'PENDING' | 'ISSUED_VOUCHER' | 'REIMBURSED' | 'CLOSED';
  employeePaidAmount?: number; // Calculated: totalAmount - voucherTotalUsed
  settlementDecision?: {
    type: 'ISSUE_VOUCHER' | 'REIMBURSE' | 'CLOSE';
    decidedBy: mongoose.Types.ObjectId;
    decidedAt: Date;
    comment?: string;
    voucherId?: mongoose.Types.ObjectId; // If type is ISSUE_VOUCHER
    reimbursementAmount?: number; // If type is REIMBURSE
  };
  /** Set when report is auto-approved (e.g. submitter was last approver under SKIP_SELF policy) */
  approvalMeta?: {
    type: 'AUTO_APPROVED';
    reason: string;
    policy: string;
    approvedAt: Date;
  };
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const expenseReportSchema = new Schema<IExpenseReport>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
    },
    projectName: {
      type: String,
      trim: true,
    },
    costCentreId: {
      type: Schema.Types.ObjectId,
      ref: 'CostCentre',
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    fromDate: {
      type: Date,
      required: true,
    },
    toDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(ExpenseReportStatus),
      default: ExpenseReportStatus.DRAFT,
      required: true,
    },
    totalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      default: 'INR',
    },
    approvers: [
      {
        level: {
          type: Number,
          required: true,
        },
        userId: {
          type: Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        role: {
          type: String,
          required: true,
        },
        decidedAt: {
          type: Date,
        },
        action: {
          type: String,
          enum: ['approve', 'reject', 'request_changes'],
        },
        comment: {
          type: String,
        },
        isAdditionalApproval: {
          type: Boolean,
          default: false,
        },
        approvalRuleId: {
          type: Schema.Types.ObjectId,
          ref: 'ApprovalRule',
        },
        triggerReason: {
          type: String,
        },
      },
    ],
    submittedAt: {
      type: Date,
    },
    approvedAt: {
      type: Date,
    },
    rejectedAt: {
      type: Date,
    },
    advanceCashId: {
      type: Schema.Types.ObjectId,
      ref: 'AdvanceCash',
    },
    advanceAppliedAmount: {
      type: Number,
      min: 0,
    },
    advanceCurrency: {
      type: String,
      trim: true,
      uppercase: true,
    },
    advanceAppliedAt: {
      type: Date,
    },
    voucherLockedAt: {
      type: Date,
    },
    voucherLockedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    appliedVouchers: [
      {
        voucherId: { type: Schema.Types.ObjectId, ref: 'AdvanceCash', required: true },
        voucherCode: { type: String, required: true, trim: true },
        amountUsed: { type: Number, required: true, min: 0 },
        currency: { type: String, required: true, trim: true, uppercase: true },
      },
    ],
    settlementStatus: {
      type: String,
      enum: ['PENDING', 'ISSUED_VOUCHER', 'REIMBURSED', 'CLOSED'],
      default: 'PENDING',
    },
    employeePaidAmount: {
      type: Number,
      min: 0,
    },
    settlementDecision: {
      type: {
        type: String,
        enum: ['ISSUE_VOUCHER', 'REIMBURSE', 'CLOSE'],
      },
      decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      decidedAt: Date,
      comment: String,
      voucherId: { type: Schema.Types.ObjectId, ref: 'AdvanceCash' },
      reimbursementAmount: Number,
    },
    approvalMeta: {
      type: { type: String, enum: ['AUTO_APPROVED'] },
      reason: String,
      policy: String,
      approvedAt: Date,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
expenseReportSchema.index({ userId: 1, status: 1, fromDate: 1, toDate: 1 });
expenseReportSchema.index({ projectId: 1, status: 1 });
expenseReportSchema.index({ status: 1, createdAt: -1 });
expenseReportSchema.index({ 'approvers.userId': 1 });

// Indexes for approval history queries
expenseReportSchema.index({ employeeName: 1 });
expenseReportSchema.index({ projectId: 1, employeeName: 1 });

// Validation
expenseReportSchema.pre('save', function (next) {
  if (this.fromDate > this.toDate) {
    next(new Error('fromDate must be before or equal to toDate'));
  } else {
    next();
  }
});

export const ExpenseReport = mongoose.model<IExpenseReport>('ExpenseReport', expenseReportSchema);


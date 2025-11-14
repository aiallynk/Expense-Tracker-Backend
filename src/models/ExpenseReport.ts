import mongoose, { Document, Schema } from 'mongoose';
import { ExpenseReportStatus } from '../utils/enums';

export interface IExpenseReport extends Document {
  userId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId;
  name: string;
  notes?: string;
  fromDate: Date;
  toDate: Date;
  status: ExpenseReportStatus;
  totalAmount: number;
  currency: string;
  submittedAt?: Date;
  approvedAt?: Date;
  rejectedAt?: Date;
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
    submittedAt: {
      type: Date,
    },
    approvedAt: {
      type: Date,
    },
    rejectedAt: {
      type: Date,
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

// Validation
expenseReportSchema.pre('save', function (next) {
  if (this.fromDate > this.toDate) {
    next(new Error('fromDate must be before or equal to toDate'));
  } else {
    next();
  }
});

export const ExpenseReport = mongoose.model<IExpenseReport>('ExpenseReport', expenseReportSchema);


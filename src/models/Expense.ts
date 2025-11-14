import mongoose, { Document, Schema } from 'mongoose';
import { ExpenseStatus, ExpenseSource } from '../utils/enums';

export interface IExpense extends Document {
  reportId: mongoose.Types.ObjectId;
  vendor: string;
  categoryId: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  expenseDate: Date;
  status: ExpenseStatus;
  source: ExpenseSource;
  notes?: string;
  receiptPrimaryId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<IExpense>(
  {
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'ExpenseReport',
      required: true,
    },
    vendor: {
      type: String,
      required: true,
      trim: true,
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'INR',
    },
    expenseDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(ExpenseStatus),
      default: ExpenseStatus.DRAFT,
      required: true,
    },
    source: {
      type: String,
      enum: Object.values(ExpenseSource),
      required: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    receiptPrimaryId: {
      type: Schema.Types.ObjectId,
      ref: 'Receipt',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
expenseSchema.index({ reportId: 1 });
expenseSchema.index({ categoryId: 1, expenseDate: 1 });
expenseSchema.index({ status: 1 });
expenseSchema.index({ vendor: 1, expenseDate: 1 });
expenseSchema.index({ expenseDate: -1 });

export const Expense = mongoose.model<IExpense>('Expense', expenseSchema);


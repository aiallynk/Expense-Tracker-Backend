import mongoose, { Document, Schema } from 'mongoose';

import { ExpenseStatus, ExpenseSource } from '../utils/enums';

export interface IExpense extends Document {
  reportId?: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  vendor: string;
  categoryId?: mongoose.Types.ObjectId;
  costCentreId?: mongoose.Types.ObjectId; // Cost Centre reference
  projectId?: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  expenseDate: Date;
  // Invoice fields for duplicate detection
  invoiceId?: string; // Invoice number/ID
  invoiceDate?: Date; // Invoice date
  status: ExpenseStatus;
  source: ExpenseSource;
  notes?: string;
  receiptIds: mongoose.Types.ObjectId[];
  receiptPrimaryId?: mongoose.Types.ObjectId;
  // Bulk upload tracking
  sourceDocumentType?: 'pdf' | 'excel' | 'image';
  sourceDocumentSequence?: number; // Receipt number in the source document (page number for PDF)
  // Manager feedback
  managerComment?: string; // Comment from manager when rejecting/requesting changes
  managerAction?: 'approve' | 'reject' | 'request_changes'; // Last manager action
  managerActionAt?: Date; // When manager took action
  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<IExpense>(
  {
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'ExpenseReport',
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
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
    },
    costCentreId: {
      type: Schema.Types.ObjectId,
      ref: 'CostCentre',
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
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
    // Invoice fields for duplicate detection
    invoiceId: {
      type: String,
      trim: true,
    },
    invoiceDate: {
      type: Date,
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
    receiptIds: {
      type: [Schema.Types.ObjectId],
      ref: 'Receipt',
      default: [],
    },
    receiptPrimaryId: {
      type: Schema.Types.ObjectId,
      ref: 'Receipt',
    },
    // Bulk upload tracking
    sourceDocumentType: {
      type: String,
      enum: ['pdf', 'excel', 'image'],
    },
    sourceDocumentSequence: {
      type: Number, // Receipt number in the source document (page number for PDF, row for Excel)
    },
    // Manager feedback
    managerComment: {
      type: String,
      trim: true,
    },
    managerAction: {
      type: String,
      enum: ['approve', 'reject', 'request_changes'],
    },
    managerActionAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
expenseSchema.index({ reportId: 1 });
expenseSchema.index({ userId: 1 });
expenseSchema.index({ categoryId: 1, expenseDate: 1 });
expenseSchema.index({ costCentreId: 1, expenseDate: 1 }); // Index for cost centre queries
expenseSchema.index({ projectId: 1 });
expenseSchema.index({ status: 1 });
expenseSchema.index({ vendor: 1, expenseDate: 1 });
expenseSchema.index({ expenseDate: -1 });
// Index for duplicate invoice detection
expenseSchema.index({ invoiceId: 1, vendor: 1, invoiceDate: 1, amount: 1 }, { sparse: true });

export const Expense = mongoose.model<IExpense>('Expense', expenseSchema);


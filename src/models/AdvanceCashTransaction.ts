import mongoose, { Document, Schema } from 'mongoose';

export interface IAdvanceCashTransaction extends Document {
  companyId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  expenseId?: mongoose.Types.ObjectId; // Optional for backward compatibility (expense-level)
  reportId: mongoose.Types.ObjectId; // Required for report-level transactions
  amount: number;
  currency: string;
  allocations: Array<{ advanceCashId: mongoose.Types.ObjectId; amount: number }>;
  createdAt: Date;
  updatedAt: Date;
}

const advanceCashTransactionSchema = new Schema<IAdvanceCashTransaction>(
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
    expenseId: {
      type: Schema.Types.ObjectId,
      ref: 'Expense',
      index: true,
      // Removed unique constraint to support report-level transactions
      // unique: true was for expense-level idempotency
    },
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'ExpenseReport',
      required: true,
      index: true,
    },
    amount: {
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
    allocations: {
      type: [
        new Schema(
          {
            advanceCashId: { type: Schema.Types.ObjectId, ref: 'AdvanceCash', required: true },
            amount: { type: Number, required: true, min: 0 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

advanceCashTransactionSchema.index({ companyId: 1, employeeId: 1, createdAt: -1 });
advanceCashTransactionSchema.index({ 'allocations.advanceCashId': 1 });
advanceCashTransactionSchema.index({ reportId: 1 }); // Index for report-level queries
// Compound index for idempotency: one transaction per report (report-level)
advanceCashTransactionSchema.index({ reportId: 1 }, { unique: true, partialFilterExpression: { expenseId: { $exists: false } } });

export const AdvanceCashTransaction = mongoose.model<IAdvanceCashTransaction>(
  'AdvanceCashTransaction',
  advanceCashTransactionSchema
);



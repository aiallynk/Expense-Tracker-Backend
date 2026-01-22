import mongoose, { Document, Schema } from 'mongoose';

export enum LedgerEntryType {
  VOUCHER_ISSUED = 'VOUCHER_ISSUED',
  VOUCHER_USED = 'VOUCHER_USED',
  VOUCHER_RETURNED = 'VOUCHER_RETURNED',
  VOUCHER_REVERSED = 'VOUCHER_REVERSED',
}

export interface ILedger extends Document {
  companyId: mongoose.Types.ObjectId;
  entryType: LedgerEntryType;
  voucherId?: mongoose.Types.ObjectId;
  reportId?: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  debitAccount?: string;
  creditAccount?: string;
  description: string;
  referenceId?: string;
  financialYear: string;
  entryDate: Date;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
}

const ledgerSchema = new Schema<ILedger>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    entryType: {
      type: String,
      enum: Object.values(LedgerEntryType),
      required: true,
      index: true,
    },
    voucherId: {
      type: Schema.Types.ObjectId,
      ref: 'AdvanceCash',
      index: true,
    },
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'ExpenseReport',
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'INR',
      required: true,
      trim: true,
      uppercase: true,
    },
    debitAccount: {
      type: String,
      trim: true,
    },
    creditAccount: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    referenceId: {
      type: String,
      trim: true,
    },
    financialYear: {
      type: String,
      required: true,
      index: true,
    },
    entryDate: {
      type: Date,
      required: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes for queries
ledgerSchema.index({ companyId: 1, financialYear: 1, entryDate: -1 }); // Financial year reports
ledgerSchema.index({ voucherId: 1 }); // Voucher ledger entries
ledgerSchema.index({ reportId: 1 }); // Report ledger entries
ledgerSchema.index({ entryType: 1, entryDate: -1 }); // Entry type queries

export const Ledger = mongoose.model<ILedger>('Ledger', ledgerSchema);

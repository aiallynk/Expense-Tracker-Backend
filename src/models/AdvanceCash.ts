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



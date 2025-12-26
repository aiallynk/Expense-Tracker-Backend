import mongoose, { Document, Schema } from 'mongoose';

export enum CostCentreStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export interface ICostCentre extends Document {
  name: string;
  code?: string;
  description?: string;
  budget?: number;
  companyId?: mongoose.Types.ObjectId;
  status: CostCentreStatus;
  createdAt: Date;
  updatedAt: Date;
}

const costCentreSchema = new Schema<ICostCentre>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
    },
    description: {
      type: String,
      trim: true,
    },
    budget: {
      type: Number,
      min: 0,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
    },
    status: {
      type: String,
      enum: Object.values(CostCentreStatus),
      default: CostCentreStatus.ACTIVE,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes - name must be unique within a company
costCentreSchema.index({ companyId: 1, name: 1 }, { unique: true });
costCentreSchema.index({ companyId: 1, status: 1 });
costCentreSchema.index({ code: 1 }, { unique: true, sparse: true });

export const CostCentre = mongoose.model<ICostCentre>('CostCentre', costCentreSchema);


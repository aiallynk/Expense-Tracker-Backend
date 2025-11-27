import mongoose, { Document, Schema } from 'mongoose';

export enum CategoryStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export interface ICategory extends Document {
  name: string;
  code?: string;
  description?: string;
  companyId?: mongoose.Types.ObjectId;
  status: CategoryStatus;
  isCustom: boolean; // false for default/predefined categories
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<ICategory>(
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
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
    },
    status: {
      type: String,
      enum: Object.values(CategoryStatus),
      default: CategoryStatus.ACTIVE,
      required: true,
    },
    isCustom: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes - name must be unique within a company (or globally for system categories)
categorySchema.index({ companyId: 1, name: 1 }, { unique: true });
categorySchema.index({ companyId: 1, status: 1 });
categorySchema.index({ code: 1 }, { unique: true, sparse: true });

export const Category = mongoose.model<ICategory>('Category', categorySchema);

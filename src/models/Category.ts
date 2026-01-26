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

// Indexes - allow duplicate category names within a company (categories are common across companies)
// Removed unique constraint to allow duplicate category names
categorySchema.index({ companyId: 1, name: 1 }); // Non-unique index for query performance
categorySchema.index({ companyId: 1, status: 1 });
categorySchema.index({ code: 1 }, { unique: true, sparse: true }); // Code remains unique if provided

export const Category = mongoose.model<ICategory>('Category', categorySchema);

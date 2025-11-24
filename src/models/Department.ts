import mongoose, { Document, Schema } from 'mongoose';

export enum DepartmentStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export interface IDepartment extends Document {
  name: string;
  code?: string;
  description?: string;
  companyId: mongoose.Types.ObjectId;
  status: DepartmentStatus;
  isCustom: boolean; // false for predefined departments
  headId?: mongoose.Types.ObjectId; // Department head/manager
  createdAt: Date;
  updatedAt: Date;
}

const departmentSchema = new Schema<IDepartment>(
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
      required: true,
      // Index created explicitly below, no need for index: true
    },
    status: {
      type: String,
      enum: Object.values(DepartmentStatus),
      default: DepartmentStatus.ACTIVE,
      required: true,
    },
    isCustom: {
      type: Boolean,
      default: false,
    },
    headId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes - name must be unique within a company
departmentSchema.index({ companyId: 1, name: 1 }, { unique: true });
departmentSchema.index({ companyId: 1, status: 1 });
departmentSchema.index({ companyId: 1, isCustom: 1 });
departmentSchema.index({ headId: 1 });

export const Department = mongoose.model<IDepartment>('Department', departmentSchema);


import mongoose, { Document, Schema } from 'mongoose';

export enum ProjectStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  COMPLETED = 'COMPLETED',
}

export interface IProject extends Document {
  name: string;
  code?: string;
  description?: string;
  companyId: mongoose.Types.ObjectId;
  managerId?: mongoose.Types.ObjectId;
  startDate?: Date;
  endDate?: Date;
  budget?: number;
  spentAmount?: number; // Total amount spent on this project
  thresholdPercentage?: number; // Percentage threshold for additional approval (e.g., 80 = 80% of budget)
  status: ProjectStatus;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
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
    },
    managerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
    budget: {
      type: Number,
      min: 0,
    },
    spentAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    thresholdPercentage: {
      type: Number,
      min: 0,
      max: 100,
      default: 80, // Default 80% threshold
    },
    status: {
      type: String,
      enum: Object.values(ProjectStatus),
      default: ProjectStatus.ACTIVE,
      required: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Indexes - name must be unique within a company
projectSchema.index({ companyId: 1, name: 1 }, { unique: true });
projectSchema.index({ companyId: 1, status: 1 });
projectSchema.index({ companyId: 1, code: 1 }, { unique: true, sparse: true });
projectSchema.index({ managerId: 1 });

export const Project = mongoose.model<IProject>('Project', projectSchema);

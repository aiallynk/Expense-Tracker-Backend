import mongoose, { Document, Schema } from 'mongoose';

export interface IProjectStakeholder extends Document {
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  assignedBy: mongoose.Types.ObjectId; // User who assigned this stakeholder
  assignedAt: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const projectStakeholderSchema = new Schema<IProjectStakeholder>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient queries
projectStakeholderSchema.index({ projectId: 1, userId: 1 }, { unique: true }); // One assignment per user per project
projectStakeholderSchema.index({ userId: 1, isActive: 1 }); // Find user's active projects
projectStakeholderSchema.index({ projectId: 1, isActive: 1 }); // Find active stakeholders for a project
projectStakeholderSchema.index({ companyId: 1, isActive: 1 }); // Company-wide queries
projectStakeholderSchema.index({ assignedBy: 1 }); // Track assignments by user

export const ProjectStakeholder = mongoose.model<IProjectStakeholder>('ProjectStakeholder', projectStakeholderSchema);

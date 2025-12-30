import mongoose, { Document, Schema } from 'mongoose';

/**
 * Approver Mapping Model
 * Maps users to their approvers at different levels (L1-L5)
 * This allows admin to configure custom approval chains
 */
export interface IApproverMapping extends Document {
  userId: mongoose.Types.ObjectId; // User who needs approval
  companyId: mongoose.Types.ObjectId; // Company context
  level1ApproverId?: mongoose.Types.ObjectId; // L1 Approver
  level2ApproverId?: mongoose.Types.ObjectId; // L2 Approver
  level3ApproverId?: mongoose.Types.ObjectId; // L3 Approver
  level4ApproverId?: mongoose.Types.ObjectId; // L4 Approver
  level5ApproverId?: mongoose.Types.ObjectId; // L5 Approver
  isActive: boolean;
  createdBy?: mongoose.Types.ObjectId; // Admin who created this mapping
  updatedBy?: mongoose.Types.ObjectId; // Admin who last updated
  createdAt: Date;
  updatedAt: Date;
}

const approverMappingSchema = new Schema<IApproverMapping>(
  {
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
    level1ApproverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    level2ApproverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    level3ApproverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    level4ApproverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    level5ApproverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes - One active mapping per user per company
approverMappingSchema.index({ userId: 1, companyId: 1, isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
approverMappingSchema.index({ companyId: 1, isActive: 1 });
approverMappingSchema.index({ level1ApproverId: 1 });
approverMappingSchema.index({ level2ApproverId: 1 });
approverMappingSchema.index({ level3ApproverId: 1 });
approverMappingSchema.index({ level4ApproverId: 1 });
approverMappingSchema.index({ level5ApproverId: 1 });

export const ApproverMapping = mongoose.model<IApproverMapping>('ApproverMapping', approverMappingSchema);


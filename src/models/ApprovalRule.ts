import mongoose, { Document, Schema } from 'mongoose';

export enum ApprovalRuleTriggerType {
  REPORT_AMOUNT_EXCEEDS = 'REPORT_AMOUNT_EXCEEDS',
  PROJECT_BUDGET_EXCEEDS = 'PROJECT_BUDGET_EXCEEDS',
  COST_CENTRE_BUDGET_EXCEEDS = 'COST_CENTRE_BUDGET_EXCEEDS',
}

export enum ApprovalRuleApproverRole {
  ADMIN = 'ADMIN',
  BUSINESS_HEAD = 'BUSINESS_HEAD',
  ACCOUNTANT = 'ACCOUNTANT',
  COMPANY_ADMIN = 'COMPANY_ADMIN',
}

export interface IApprovalRule extends Document {
  companyId: mongoose.Types.ObjectId;
  triggerType: ApprovalRuleTriggerType;
  thresholdValue: number; // Amount or percentage depending on triggerType
  approverRole?: ApprovalRuleApproverRole; // System role (for backward compatibility)
  approverRoleId?: mongoose.Types.ObjectId; // Custom role from Role model (new)
  approverUserId?: mongoose.Types.ObjectId; // Specific user when role has multiple users
  active: boolean;
  description?: string; // Human-readable description for admin UI
  createdAt: Date;
  updatedAt: Date;
}

const approvalRuleSchema = new Schema<IApprovalRule>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    triggerType: {
      type: String,
      enum: Object.values(ApprovalRuleTriggerType),
      required: true,
    },
    thresholdValue: {
      type: Number,
      required: true,
      min: 0,
    },
    approverRole: {
      type: String,
      enum: Object.values(ApprovalRuleApproverRole),
      required: false, // Now optional - can use approverRoleId instead
    },
    approverRoleId: {
      type: Schema.Types.ObjectId,
      ref: 'Role',
      required: false, // Optional - can use approverRole instead
    },
    approverUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false, // When role has multiple users, specifies which user is the approver
    },
    active: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Validation: Either approverRole or approverRoleId must be provided
approvalRuleSchema.pre('validate', function(next) {
  if (!this.approverRole && !this.approverRoleId) {
    return next(new Error('Either approverRole or approverRoleId must be provided'));
  }
  if (this.approverRole && this.approverRoleId) {
    return next(new Error('Cannot specify both approverRole and approverRoleId'));
  }
  next();
});

// Indexes
approvalRuleSchema.index({ companyId: 1, active: 1 });
approvalRuleSchema.index({ companyId: 1, triggerType: 1 });
approvalRuleSchema.index({ approverRoleId: 1 });

export const ApprovalRule = mongoose.model<IApprovalRule>('ApprovalRule', approvalRuleSchema);


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
  approverRole: ApprovalRuleApproverRole;
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
      required: true,
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

// Indexes
approvalRuleSchema.index({ companyId: 1, active: 1 });
approvalRuleSchema.index({ companyId: 1, triggerType: 1 });

export const ApprovalRule = mongoose.model<IApprovalRule>('ApprovalRule', approvalRuleSchema);


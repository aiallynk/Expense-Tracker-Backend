import mongoose, { Document, Schema } from 'mongoose';

export interface IApproverLevel {
  level: number;
  mode: 'SEQUENTIAL' | 'PARALLEL';
  approvalType: 'ANY' | 'ALL' | null;
  roles: string[]; // Internal roleId refs (as String)
  approverUserIds?: string[]; // Optional: specific user IDs for this level (when role has multiple users)
}

export interface IEmployeeApprovalProfile extends Document {
  userId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId;
  approverChain: IApproverLevel[];
  confidenceScore?: number;
  reasoningSummary?: string;
  aiRawJson?: any;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  source: 'ai' | 'manual';
}

const ApproverLevelSchema = new Schema<IApproverLevel>({
  level: { type: Number, required: true },
  mode: { type: String, enum: ['SEQUENTIAL', 'PARALLEL'], required: true },
  approvalType: { type: String, enum: ['ANY', 'ALL', null], default: null },
  roles: [{ type: String, required: true }],
  approverUserIds: [{ type: String }],
}, { _id: false });

const EmployeeApprovalProfileSchema = new Schema<IEmployeeApprovalProfile>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  approverChain: { type: [ApproverLevelSchema], required: true },
  confidenceScore: { type: Number },
  reasoningSummary: { type: String },
  aiRawJson: { type: Schema.Types.Mixed },
  active: { type: Boolean, default: true },
  version: { type: Number, default: 1 },
  source: { type: String, enum: ['ai', 'manual'], required: true },
}, { timestamps: true });

EmployeeApprovalProfileSchema.index({ userId: 1, companyId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });

export const EmployeeApprovalProfile = mongoose.model<IEmployeeApprovalProfile>('EmployeeApprovalProfile', EmployeeApprovalProfileSchema);


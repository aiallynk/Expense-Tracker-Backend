import mongoose, { Schema, Document } from 'mongoose';

export enum ApprovalStatus {
    PENDING = 'PENDING',
    APPROVED = 'APPROVED',
    REJECTED = 'REJECTED',
    CHANGES_REQUESTED = 'CHANGES_REQUESTED',
    SKIPPED = 'SKIPPED',
}

export interface IApprovalHistory {
    levelNumber: number;
    status: ApprovalStatus;
    approverId?: mongoose.Types.ObjectId;
    roleId?: mongoose.Types.ObjectId;
    timestamp: Date;
    comments?: string;
}

/** Per-instance override levels (e.g. from EmployeeApprovalProfile). When set, used instead of matrix.levels. */
export interface IApprovalLevelOverride {
    levelNumber: number;
    enabled: boolean;
    approvalType: string;
    parallelRule?: string;
    approverRoleIds?: mongoose.Types.ObjectId[];
    approverUserIds?: mongoose.Types.ObjectId[];
    conditions?: any[];
    skipAllowed?: boolean;
}

export interface IApprovalInstance extends Document {
    companyId: mongoose.Types.ObjectId;
    matrixId: mongoose.Types.ObjectId;
    requestId: mongoose.Types.ObjectId; // Reference to Expense/Trip request
    requestType: string; // e.g., 'EXPENSE', 'TRIP'
    currentLevel: number;
    status: ApprovalStatus;
    history: IApprovalHistory[];
    /** When set (e.g. personalized matrix), used instead of matrix.levels for this instance. */
    effectiveLevels?: IApprovalLevelOverride[];
    createdAt: Date;
    updatedAt: Date;
}

const ApprovalHistorySchema = new Schema<IApprovalHistory>({
    levelNumber: { type: Number, required: true },
    status: {
        type: String,
        enum: Object.values(ApprovalStatus),
        required: true,
    },
    approverId: { type: Schema.Types.ObjectId, ref: 'User' },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role' },
    timestamp: { type: Date, default: Date.now },
    comments: String,
}, { _id: false });

const ApprovalInstanceSchema = new Schema<IApprovalInstance>(
    {
        companyId: {
            type: Schema.Types.ObjectId,
            ref: 'Company',
            required: true,
        },
        matrixId: {
            type: Schema.Types.ObjectId,
            ref: 'ApprovalMatrix',
            required: true,
        },
        requestId: {
            type: Schema.Types.ObjectId,
            required: true,
        },
        requestType: {
            type: String,
            required: true,
            default: 'EXPENSE',
        },
        currentLevel: {
            type: Number,
            default: 1,
        },
        status: {
            type: String,
            enum: Object.values(ApprovalStatus),
            default: ApprovalStatus.PENDING,
        },
        history: [ApprovalHistorySchema],
        effectiveLevels: [{ type: Schema.Types.Mixed }],
    },
    {
        timestamps: true,
    }
);

// Indexes for faster querying of pending items for a company
ApprovalInstanceSchema.index({ companyId: 1, status: 1 });

// Indexes for approval history queries
ApprovalInstanceSchema.index({ 'history.approverId': 1, 'history.timestamp': -1 });
ApprovalInstanceSchema.index({ 'history.approverId': 1, 'history.status': 1, 'history.timestamp': -1 });
ApprovalInstanceSchema.index({ requestId: 1 }); // For joining with expense reports
ApprovalInstanceSchema.index({ status: 1 }); // Status queries

export const ApprovalInstance = mongoose.model<IApprovalInstance>('ApprovalInstance', ApprovalInstanceSchema);

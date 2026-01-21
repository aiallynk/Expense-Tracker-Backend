import mongoose, { Schema, Document } from 'mongoose';

export enum ApprovalType {
    SEQUENTIAL = 'SEQUENTIAL',
    PARALLEL = 'PARALLEL',
}

export enum ParallelRule {
    ALL = 'ALL',
    ANY = 'ANY',
}

export enum ConditionType {
    AMOUNT = 'AMOUNT',
    BUDGET = 'BUDGET',
    POLICY = 'POLICY',
}

export enum ConditionOperator {
    GT = '>',
    LT = '<',
    GTE = '>=',
    LTE = '<=',
    EQ = '==',
}

export enum ActionType {
    ACTIVATE = 'ACTIVATE',
    SKIP = 'SKIP',
}

export interface IApprovalCondition {
    type: ConditionType;
    operator: ConditionOperator;
    value: any; // Can be number or string depending on context
    action: ActionType;
}

export interface IApprovalLevel {
    levelNumber: number;
    enabled: boolean;
    approvalType: ApprovalType;
    parallelRule?: ParallelRule;
    approverRoleIds?: mongoose.Types.ObjectId[]; // For backward compatibility
    approverUserIds?: mongoose.Types.ObjectId[]; // New format: specific users
    conditions: IApprovalCondition[];
    skipAllowed: boolean;
}

export interface IApprovalMatrix extends Document {
    companyId: mongoose.Types.ObjectId;
    name: string;
    description?: string;
    isActive: boolean;
    levels: IApprovalLevel[];
    createdAt: Date;
    updatedAt: Date;
}

const ApprovalConditionSchema = new Schema<IApprovalCondition>({
    type: {
        type: String,
        enum: Object.values(ConditionType),
        required: true,
    },
    operator: {
        type: String,
        enum: Object.values(ConditionOperator),
        required: true,
    },
    value: {
        type: Schema.Types.Mixed,
        required: true,
    },
    action: {
        type: String,
        enum: Object.values(ActionType),
        required: true,
    },
}, { _id: false });

const ApprovalLevelSchema = new Schema<IApprovalLevel>({
    levelNumber: {
        type: Number,
        required: true,
    },
    enabled: {
        type: Boolean,
        default: true,
    },
    approvalType: {
        type: String,
        enum: Object.values(ApprovalType),
        required: true,
    },
    parallelRule: {
        type: String,
        enum: Object.values(ParallelRule),
        required (this: IApprovalLevel) {
            return this.approvalType === ApprovalType.PARALLEL;
        },
    },
    approverRoleIds: [
        {
            type: Schema.Types.ObjectId,
            ref: 'Role',
        },
    ],
    approverUserIds: [
        {
            type: Schema.Types.ObjectId,
            ref: 'User',
        },
    ],
    conditions: [ApprovalConditionSchema],
    skipAllowed: {
        type: Boolean,
        default: false,
    },
}, { _id: true }); // Keep ID for level addressing if needed

const ApprovalMatrixSchema = new Schema<IApprovalMatrix>(
    {
        companyId: {
            type: Schema.Types.ObjectId,
            ref: 'Company',
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        description: {
            type: String,
            trim: true,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        levels: [ApprovalLevelSchema],
    },
    {
        timestamps: true,
    }
);

// Ensure there is only one active matrix per company? Or maybe multiple types.
// Fore now, let's index companyId.
ApprovalMatrixSchema.index({ companyId: 1 });

export const ApprovalMatrix = mongoose.model<IApprovalMatrix>('ApprovalMatrix', ApprovalMatrixSchema);

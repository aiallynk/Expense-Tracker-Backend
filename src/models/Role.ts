import mongoose, { Schema, Document } from 'mongoose';

export enum RoleType {
  SYSTEM = 'SYSTEM',
  CUSTOM = 'CUSTOM',
}

export interface IRole extends Document {
  companyId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  type: RoleType;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const RoleSchema = new Schema<IRole>(
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
    type: {
      type: String,
      enum: Object.values(RoleType),
      default: RoleType.CUSTOM,
      required: true,
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

// Prevent duplicate role names within the same company
RoleSchema.index({ companyId: 1, name: 1 }, { unique: true });

export const Role = mongoose.model<IRole>('Role', RoleSchema);

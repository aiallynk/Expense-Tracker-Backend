import mongoose, { Document, Schema } from 'mongoose';

export interface IProject extends Document {
  name: string;
  code?: string;
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

// Indexes
projectSchema.index({ name: 1 }, { unique: true });
projectSchema.index({ code: 1 }, { unique: true, sparse: true });

export const Project = mongoose.model<IProject>('Project', projectSchema);


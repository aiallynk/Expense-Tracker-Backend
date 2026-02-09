import mongoose, { Document, Schema } from 'mongoose';

import { AiFeature } from '../utils/enums';

export interface IAiTokenUsage extends Omit<Document, 'model'> {
  companyId: string;
  userId: string;
  feature: AiFeature;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  requestId?: string;
  createdAt: Date;
}

const aiTokenUsageSchema = new Schema<IAiTokenUsage>(
  {
    companyId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    feature: {
      type: String,
      enum: Object.values(AiFeature),
      required: true,
    },
    model: {
      type: String,
      required: true,
    },
    promptTokens: {
      type: Number,
      required: true,
      default: 0,
    },
    completionTokens: {
      type: Number,
      required: true,
      default: 0,
    },
    totalTokens: {
      type: Number,
      required: true,
      default: 0,
    },
    costUsd: {
      type: Number,
      required: true,
      default: 0,
    },
    requestId: {
      type: String,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes for efficient analytics queries
aiTokenUsageSchema.index({ companyId: 1, createdAt: 1 });
aiTokenUsageSchema.index({ userId: 1, createdAt: 1 });
aiTokenUsageSchema.index({ createdAt: 1 });
aiTokenUsageSchema.index({ feature: 1 });
aiTokenUsageSchema.index({ model: 1 });
aiTokenUsageSchema.index({ companyId: 1, feature: 1 });

export const AiTokenUsage = mongoose.model<IAiTokenUsage>('AiTokenUsage', aiTokenUsageSchema);

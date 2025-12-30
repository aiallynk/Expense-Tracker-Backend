import bcrypt from 'bcrypt';
import mongoose, { Document, Schema } from 'mongoose';

export interface IServiceAccount extends Document {
  name: string;
  apiKeyHash: string; // Hashed API key (never store plain text)
  companyId?: mongoose.Types.ObjectId; // Nullable for super-admin analytics
  allowedEndpoints: string[]; // Exact paths or regex patterns
  expiresAt?: Date; // Optional expiration date
  isActive: boolean;
  lastUsedAt?: Date; // Track last usage
  createdBy: mongoose.Types.ObjectId; // COMPANY_ADMIN who created it
  createdAt: Date;
  updatedAt: Date;
  
  // Method to compare API key
  compareApiKey(candidateKey: string): Promise<boolean>;
}

const serviceAccountSchema = new Schema<IServiceAccount>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    apiKeyHash: {
      type: String,
      required: true,
      select: false, // Don't return by default in queries
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      index: true,
    },
    allowedEndpoints: {
      type: [String],
      required: true,
      default: [],
      validate: {
        validator: (v: string[]) => v.length > 0,
        message: 'At least one allowed endpoint is required',
      },
    },
    expiresAt: {
      type: Date,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastUsedAt: {
      type: Date,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
serviceAccountSchema.index({ companyId: 1, isActive: 1 });
serviceAccountSchema.index({ apiKeyHash: 1 }); // For fast lookup during auth
serviceAccountSchema.index({ expiresAt: 1, isActive: 1 }); // For cleanup queries

// Method to compare API key
serviceAccountSchema.methods.compareApiKey = async function (
  candidateKey: string
): Promise<boolean> {
  return bcrypt.compare(candidateKey, this.apiKeyHash);
};

// Static method to hash API key
serviceAccountSchema.statics.hashApiKey = async function (
  apiKey: string
): Promise<string> {
  const saltRounds = 12; // Higher than password (10) for extra security
  return bcrypt.hash(apiKey, saltRounds);
};

// Note: API keys should be hashed BEFORE saving to the model
// The pre-save hook is disabled to prevent accidental re-hashing
// Use ServiceAccountService.hashApiKey() before creating/updating

export const ServiceAccount = mongoose.model<IServiceAccount>(
  'ServiceAccount',
  serviceAccountSchema
);


import mongoose, { Document, Schema } from 'mongoose';

export interface IGlobalSettings extends Document {
  // ... other sections unchanged
  integrations: {
    openAiApiKey: string; // NEW
    awsS3AccessKey: string;
    awsS3SecretKey: string;
    awsS3Region: string;
    awsS3Bucket: string;
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPassword: string;
    paymentGateway: string;
  };
  updatedBy?: mongoose.Types.ObjectId;
  updatedAt: Date;
}

const globalSettingsSchema = new Schema<IGlobalSettings>(
  {
    // ...other config sections...
    integrations: {
      openAiApiKey: { type: String, default: '' }, // NEW
      awsS3AccessKey: { type: String, default: '' },
      awsS3SecretKey: { type: String, default: '' },
      awsS3Region: { type: String, default: 'ap-south-1' },
      awsS3Bucket: { type: String, default: '' },
      smtpHost: { type: String, default: 'smtp.resend.com' },
      smtpPort: { type: Number, default: 587 },
      smtpUser: { type: String, default: '' },
      smtpPassword: { type: String, default: '' },
      paymentGateway: { type: String, default: 'razorpay' },
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
  }
);

// Only export new openAiApiKey; togetherAiApiKey is removed
// Helper remains unchanged

globalSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

export const GlobalSettings = mongoose.model<IGlobalSettings>('GlobalSettings', globalSettingsSchema);

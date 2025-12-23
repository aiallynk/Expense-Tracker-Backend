import mongoose, { Document, Schema } from 'mongoose';

export interface IGlobalSettings extends Document {
  fileUpload: {
    maxFileSize: number; // MB
    allowedTypes: string[];
    autoDeleteMonths: number;
  };
  features: {
    ocrEnabled: boolean;
    pdfExportEnabled: boolean;
    teamBuilderEnabled: boolean;
    businessHeadApprovalEnabled: boolean;
    darkModeEnabled: boolean;
    maintenanceMode: boolean;
    registrationEnabled: boolean;
  };
  security: {
    sessionTimeout: number; // minutes
    maxLoginAttempts: number;
    rateLimitPerMinute: number;
    ipRestrictions: boolean;
    requireMfa: boolean;
    passwordMinLength: number;
  };
  notifications: {
    emailEnabled: boolean;
    smsEnabled: boolean;
    pushEnabled: boolean;
    defaultEmailFrom: string;
  };
  storage: {
    maxStoragePerCompany: number; // GB
    maxStoragePerUser: number; // GB
    cleanupEnabled: boolean;
  };
  system: {
    platformName: string;
    supportEmail: string;
    supportPhone: string;
    timezone: string;
    dateFormat: string;
    currency: string;
  };
  integrations: {
    togetherAiApiKey: string;
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
    fileUpload: {
      maxFileSize: { type: Number, default: 10 },
      allowedTypes: { type: [String], default: ['jpg', 'jpeg', 'png', 'pdf'] },
      autoDeleteMonths: { type: Number, default: 12 },
    },
    features: {
      ocrEnabled: { type: Boolean, default: true },
      pdfExportEnabled: { type: Boolean, default: true },
      teamBuilderEnabled: { type: Boolean, default: true },
      businessHeadApprovalEnabled: { type: Boolean, default: true },
      darkModeEnabled: { type: Boolean, default: false },
      maintenanceMode: { type: Boolean, default: false },
      registrationEnabled: { type: Boolean, default: true },
    },
    security: {
      sessionTimeout: { type: Number, default: 30 },
      maxLoginAttempts: { type: Number, default: 5 },
      rateLimitPerMinute: { type: Number, default: 60 },
      ipRestrictions: { type: Boolean, default: false },
      requireMfa: { type: Boolean, default: false },
      passwordMinLength: { type: Number, default: 8 },
    },
    notifications: {
      emailEnabled: { type: Boolean, default: true },
      smsEnabled: { type: Boolean, default: false },
      pushEnabled: { type: Boolean, default: true },
      defaultEmailFrom: { type: String, default: 'no-reply@aially.in' },
    },
    storage: {
      maxStoragePerCompany: { type: Number, default: 100 }, // GB
      maxStoragePerUser: { type: Number, default: 10 }, // GB
      cleanupEnabled: { type: Boolean, default: true },
    },
    system: {
      platformName: { type: String, default: 'Expense Tracker' },
      supportEmail: { type: String, default: 'support@aially.in' },
      supportPhone: { type: String, default: '' },
      timezone: { type: String, default: 'Asia/Kolkata' },
      dateFormat: { type: String, default: 'DD/MM/YYYY' },
      currency: { type: String, default: 'INR' },
    },
    integrations: {
      togetherAiApiKey: { type: String, default: '' },
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

// Ensure only one settings document exists
globalSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

export const GlobalSettings = mongoose.model<IGlobalSettings>('GlobalSettings', globalSettingsSchema);


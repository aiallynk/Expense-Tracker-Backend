import mongoose, { Document, Schema } from 'mongoose';

export interface ICompanySettings extends Document {
  companyId: mongoose.Types.ObjectId;
  
  // Approval Flow Settings (Legacy - kept for backward compatibility)
  approvalFlow: {
    requireManagerApproval: boolean;
    requireBusinessHeadApproval: boolean;
    multiLevelApproval: number; // 1-5 levels
    autoApproveThreshold?: number; // Amount threshold for auto-approval (optional)
    defaultApproverId?: mongoose.Types.ObjectId; // Default manager/user ID
  };

  // Approval Matrix Configuration (New - replaces approvalFlow for L3-L5)
  approvalMatrix?: {
    level3?: {
      enabled: boolean;
      approverRoles: string[]; // e.g., ['BUSINESS_HEAD', 'ADMIN']
    };
    level4?: {
      enabled: boolean;
      approverRoles: string[]; // e.g., ['ADMIN', 'COMPANY_ADMIN']
    };
    level5?: {
      enabled: boolean;
      approverRoles: string[]; // e.g., ['COMPANY_ADMIN']
    };
  };

  // Expense Settings
  expense: {
    requireReceipt: boolean;
    requireReceiptAbove?: number; // Amount threshold for requiring receipt
    maxFileSize: number; // MB
    allowedFileTypes: string[];
    maxExpenseAmount?: number; // Maximum single expense amount (optional)
    requireCategory: boolean;
  };

  // General Company Settings
  general: {
    timezone: string;
    currency: string;
    dateFormat: string;
    companyName?: string;
  };

  // Financial Year Settings
  financialYear: {
    startMonth: number; // 1-12 (1 = January, 4 = April)
    startDay: number; // 1-31
    endMonth: number; // 1-12
    endDay: number; // 1-31
  };

  // Notifications Settings
  notifications: {
    emailNotifications: boolean;
    webPushNotifications: boolean;
    dailySummary: boolean;
    notifyOnApproval: boolean;
    notifyOnRejection: boolean;
  };

  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const companySettingsSchema = new Schema<ICompanySettings>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      unique: true,
      // unique: true creates an index automatically, explicit index below is redundant but kept for clarity
    },
    approvalFlow: {
      requireManagerApproval: { type: Boolean, default: true },
      requireBusinessHeadApproval: { type: Boolean, default: false },
      multiLevelApproval: { type: Number, default: 2, min: 1, max: 5 },
      autoApproveThreshold: { type: Number, min: 0 },
      defaultApproverId: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    approvalMatrix: {
      level3: {
        enabled: { type: Boolean, default: false },
        approverRoles: { type: [String], default: [] },
      },
      level4: {
        enabled: { type: Boolean, default: false },
        approverRoles: { type: [String], default: [] },
      },
      level5: {
        enabled: { type: Boolean, default: false },
        approverRoles: { type: [String], default: [] },
      },
    },
    expense: {
      requireReceipt: { type: Boolean, default: true },
      requireReceiptAbove: { type: Number, min: 0 },
      maxFileSize: { type: Number, default: 10, min: 1, max: 50 }, // MB
      allowedFileTypes: { type: [String], default: ['jpg', 'jpeg', 'png', 'pdf'] },
      maxExpenseAmount: { type: Number, min: 0 },
      requireCategory: { type: Boolean, default: true },
    },
    general: {
      timezone: { type: String, default: 'Asia/Kolkata' },
      currency: { type: String, default: 'INR' },
      dateFormat: { type: String, default: 'DD/MM/YYYY' },
      companyName: { type: String },
    },
    // Financial Year Settings (default: April 1 - March 31)
    financialYear: {
      startMonth: { type: Number, default: 4, min: 1, max: 12 }, // April
      startDay: { type: Number, default: 1, min: 1, max: 31 },
      endMonth: { type: Number, default: 3, min: 1, max: 12 }, // March
      endDay: { type: Number, default: 31, min: 1, max: 31 },
    },
    notifications: {
      emailNotifications: { type: Boolean, default: true },
      webPushNotifications: { type: Boolean, default: true },
      dailySummary: { type: Boolean, default: false },
      notifyOnApproval: { type: Boolean, default: true },
      notifyOnRejection: { type: Boolean, default: true },
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
// Note: unique: true on companyId field already creates an index, but we keep this for clarity
// Remove this line if you want to avoid the duplicate index warning
// companySettingsSchema.index({ companyId: 1 }, { unique: true });

// Static method to get or create settings for a company
companySettingsSchema.statics.getOrCreateSettings = async function (companyId: string) {
  let settings = await this.findOne({ companyId });
  
  if (!settings) {
    settings = await this.create({ companyId });
  }
  
  return settings;
};

export const CompanySettings = mongoose.model<ICompanySettings>('CompanySettings', companySettingsSchema);


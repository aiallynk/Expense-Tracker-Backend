import mongoose from 'mongoose';

import { CompanySettings, ICompanySettings } from '../models/CompanySettings';

import { logger } from '@/config/logger';

export class CompanySettingsService {
  /**
   * Get company settings by company ID
   */
  static async getSettingsByCompanyId(companyId: string): Promise<ICompanySettings> {
    const settings = await CompanySettings.findOne({ companyId });
    
    if (!settings) {
      // Create default settings if none exist
      return await CompanySettings.create({ companyId });
    }
    
    return settings;
  }

  /**
   * Update company settings
   */
  static async updateSettings(
    companyId: string,
    updates: Partial<ICompanySettings>,
    userId: string
  ): Promise<ICompanySettings> {
    let settings = await CompanySettings.findOne({ companyId });
    
    if (!settings) {
      // Create new settings if they don't exist
      settings = await CompanySettings.create({
        companyId: new mongoose.Types.ObjectId(companyId),
        ...updates,
        updatedBy: userId as any,
      });
    } else {
      // Merge updates with existing settings
      if (settings) {
        Object.keys(updates).forEach((key) => {
          if (key === 'approvalFlow' || key === 'expense' || key === 'general' || key === 'notifications') {
            (settings as any)[key] = {
              ...(settings as any)[key],
              ...(updates as any)[key],
            };
          } else if (key !== 'companyId') {
            (settings as any)[key] = (updates as any)[key];
          }
        });
      }
      
      settings.updatedBy = userId as any;
      await settings.save();
    }

    logger.info(`Company settings updated for company ${companyId} by user ${userId}`);
    
    return settings;
  }

  /**
   * Reset company settings to default
   */
  static async resetSettings(companyId: string, userId: string): Promise<ICompanySettings> {
    await CompanySettings.deleteOne({ companyId });
    const settings = await CompanySettings.create({
      companyId: new mongoose.Types.ObjectId(companyId),
      updatedBy: userId as any,
    });

    logger.info(`Company settings reset to default for company ${companyId} by user ${userId}`);
    
    return settings;
  }

  /**
   * Get approval flow settings for a company
   */
  static async getApprovalFlowSettings(companyId: string): Promise<ICompanySettings['approvalFlow']> {
    const settings = await this.getSettingsByCompanyId(companyId);
    return settings.approvalFlow;
  }
}


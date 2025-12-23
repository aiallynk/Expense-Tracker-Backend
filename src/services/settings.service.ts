import { GlobalSettings, IGlobalSettings } from '../models/GlobalSettings';
import { emitSettingsUpdated } from '../socket/realtimeEvents';
import { logger } from '@/config/logger';

// No references to togetherAiApiKey. Use openAiApiKey only

export class SettingsService {
  /** Get global settings */
  static async getSettings(): Promise<IGlobalSettings> {
    let settings = await GlobalSettings.findOne();
    if (!settings) {
      settings = await GlobalSettings.create({});
      logger.info('Created default global settings');
    }
    return settings;
  }
  /** Update global settings */
  static async updateSettings(
    updates: Partial<IGlobalSettings>,
    userId: string
  ): Promise<IGlobalSettings> {
    let settings = await GlobalSettings.findOne();
    if (!settings) {
      settings = await GlobalSettings.create({ ...updates, updatedBy: userId as any });
    } else {
      Object.keys(updates).forEach((key) => {
        if (
          key === 'fileUpload' ||
          key === 'features' ||
          key === 'security' ||
          key === 'notifications' ||
          key === 'storage' ||
          key === 'system' ||
          key === 'integrations'
        ) {
          (settings as any)[key] = {
            ...(settings as any)[key],
            ...(updates as any)[key],
          };
        } else {
          (settings as any)[key] = (updates as any)[key];
        }
      });
      settings.updatedBy = userId as any;
      await settings.save();
    }
    emitSettingsUpdated(settings.toObject());
    logger.info(`Global settings updated by user ${userId}`);
    return settings;
  }
  /** Reset settings to default */
  static async resetSettings(userId: string): Promise<IGlobalSettings> {
    await GlobalSettings.deleteMany({});
    const settings = await GlobalSettings.create({ updatedBy: userId as any });
    emitSettingsUpdated(settings.toObject());
    logger.info(`Global settings reset to default by user ${userId}`);
    return settings;
  }
  /** Get a specific setting value */
  static async getSettingValue(path: string): Promise<any> {
    const settings = await this.getSettings();
    const keys = path.split('.');
    let value: any = settings;
    for (const key of keys) {
      value = value?.[key];
      if (value === undefined) break;
    }
    return value;
  }
}

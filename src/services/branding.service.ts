import { randomUUID } from 'crypto';

import { Company } from '../models/Company';
import { UploadIntentDto } from '../utils/dtoTypes';
import { getPresignedUploadUrl, getPresignedDownloadUrl } from '../utils/s3';

import { logger } from '@/config/logger';

/**
 * Branding Service
 * Handles company logo upload and retrieval using presigned URLs
 */
export class BrandingService {
  /**
   * Create upload intent for company logo
   * @param companyId - Company ID
   * @param data - Upload intent data (filename, mimeType, sizeBytes)
   * @param mode - Logo mode: 'light' or 'dark' (default: 'light')
   * @returns Upload URL and storage key
   */
  static async createUploadIntent(
    companyId: string,
    data: UploadIntentDto,
    mode: 'light' | 'dark' = 'light'
  ): Promise<{ uploadUrl: string; storageKey: string }> {
    // Validate file type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/svg+xml', 'image/webp'];
    if (!allowedTypes.includes(data.mimeType)) {
      throw new Error(`Invalid file type. Allowed types: ${allowedTypes.join(', ')}`);
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (data.sizeBytes && data.sizeBytes > maxSize) {
      throw new Error('Logo file size exceeds 5MB limit');
    }

    // Generate storage key with mode prefix
    const fileExtension = data.filename?.split('.').pop() || 'png';
    const storageKey = `company-logos/${companyId}/${mode}/${randomUUID()}.${fileExtension}`;

    // Generate presigned upload URL
    const uploadUrl = await getPresignedUploadUrl({
      bucketType: 'receipts',
      key: storageKey,
      mimeType: data.mimeType,
      expiresIn: 3600, // 1 hour
    });

    logger.info({
      companyId,
      storageKey,
      mimeType: data.mimeType,
      filename: data.filename,
      mode,
    }, 'Created logo upload intent');

    return { uploadUrl, storageKey };
  }

  /**
   * Confirm logo upload and update company record
   * @param companyId - Company ID
   * @param storageKey - Storage key from upload intent
   * @param mode - Logo mode: 'light' or 'dark' (default: 'light')
   * @returns Logo URL and storage key
   */
  static async confirmUpload(
    companyId: string,
    storageKey: string,
    mode: 'light' | 'dark' = 'light'
  ): Promise<{ logoUrl: string; logoStorageKey: string }> {
    // Small delay to ensure S3 upload has fully propagated
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Update company record - store only storageKey, generate URL on-demand
    const company = await Company.findById(companyId);
    if (!company) {
      throw new Error('Company not found');
    }

    if (mode === 'dark') {
      // Delete old dark logo if exists
      if (company.darkLogoStorageKey && company.darkLogoStorageKey !== storageKey) {
        try {
          logger.info({ oldStorageKey: company.darkLogoStorageKey }, 'Old dark logo storage key (not deleted from S3)');
        } catch (error) {
          logger.error({ error }, 'Error handling old dark logo');
        }
      }

      // Store dark logo storage key
      company.darkLogoStorageKey = storageKey;
      company.darkLogoUrl = undefined; // Clear old URL if exists, will be generated on-demand
    } else {
      // Delete old light logo if exists
      if (company.logoStorageKey && company.logoStorageKey !== storageKey) {
        try {
          logger.info({ oldStorageKey: company.logoStorageKey }, 'Old light logo storage key (not deleted from S3)');
        } catch (error) {
          logger.error({ error }, 'Error handling old light logo');
        }
      }

      // Store light logo storage key
      company.logoStorageKey = storageKey;
      company.logoUrl = undefined; // Clear old URL if exists, will be generated on-demand
    }

    await company.save();

    // Generate fresh presigned URL (max 7 days for S3 Signature Version 4)
    const logoUrl = await getPresignedDownloadUrl('receipts', storageKey, 7 * 24 * 60 * 60); // 7 days

    logger.info({
      companyId,
      storageKey,
      mode,
      logoUrl: logoUrl.substring(0, 50) + '...',
    }, 'Logo upload confirmed');

    return { logoUrl, logoStorageKey: storageKey };
  }

  /**
   * Get company logo URL
   * Always generates a fresh presigned URL (max 7 days expiration for S3)
   * @param companyId - Company ID
   * @param mode - Logo mode: 'light' or 'dark' (default: 'light')
   * @param fallback - If true, fallback to light logo if dark logo not found (default: true)
   * @returns Logo URL or null
   */
  static async getLogoUrl(
    companyId: string,
    mode: 'light' | 'dark' = 'light',
    fallback: boolean = true
  ): Promise<string | null> {
    const company = await Company.findById(companyId).select('logoStorageKey darkLogoStorageKey').exec();

    if (!company) {
      return null;
    }

    // Try to get logo based on mode
    let storageKey: string | undefined;
    if (mode === 'dark') {
      storageKey = company.darkLogoStorageKey;
      // If dark logo not found and fallback is enabled, use light logo
      if (!storageKey && fallback) {
        storageKey = company.logoStorageKey;
      }
    } else {
      storageKey = company.logoStorageKey;
    }

    if (storageKey) {
      try {
        // Generate presigned URL with 7 days expiration (max allowed by S3)
        const logoUrl = await getPresignedDownloadUrl('receipts', storageKey, 7 * 24 * 60 * 60);
        return logoUrl;
      } catch (error) {
        logger.error({ error, companyId, storageKey }, 'Error generating logo URL');
        return null;
      }
    }

    return null;
  }

  /**
   * Get both light and dark logo URLs
   * @param companyId - Company ID
   * @returns Object with lightLogoUrl and darkLogoUrl (or null if not found)
   */
  static async getLogos(companyId: string): Promise<{ lightLogoUrl: string | null; darkLogoUrl: string | null }> {
    const lightLogoUrl = await this.getLogoUrl(companyId, 'light', false);
    const darkLogoUrl = await this.getLogoUrl(companyId, 'dark', false);
    return { lightLogoUrl, darkLogoUrl };
  }

  /**
   * Delete company logo
   * @param companyId - Company ID
   * @param mode - Logo mode: 'light' or 'dark' (default: 'light')
   */
  static async deleteLogo(companyId: string, mode: 'light' | 'dark' = 'light'): Promise<void> {
    const company = await Company.findById(companyId);
    if (!company) {
      throw new Error('Company not found');
    }

    // Note: In production, you might want to delete the file from S3
    // For now, we'll just clear the reference
    if (mode === 'dark') {
      company.darkLogoUrl = undefined;
      company.darkLogoStorageKey = undefined;
    } else {
      company.logoUrl = undefined;
      company.logoStorageKey = undefined;
    }
    await company.save();

    logger.info({ companyId, mode }, 'Company logo deleted');
  }
}


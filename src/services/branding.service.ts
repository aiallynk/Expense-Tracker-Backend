import { randomUUID } from 'crypto';

import { Company } from '../models/Company';
import { getPresignedUploadUrl, getPresignedDownloadUrl } from '../utils/s3';
import { UploadIntentDto } from '../utils/dtoTypes';
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
   * @returns Upload URL and storage key
   */
  static async createUploadIntent(
    companyId: string,
    data: UploadIntentDto
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

    // Generate storage key
    const fileExtension = data.filename?.split('.').pop() || 'png';
    const storageKey = `company-logos/${companyId}/${randomUUID()}.${fileExtension}`;

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
    }, 'Created logo upload intent');

    return { uploadUrl, storageKey };
  }

  /**
   * Confirm logo upload and update company record
   * @param companyId - Company ID
   * @param storageKey - Storage key from upload intent
   * @returns Logo URL and storage key
   */
  static async confirmUpload(
    companyId: string,
    storageKey: string
  ): Promise<{ logoUrl: string; logoStorageKey: string }> {
    // Small delay to ensure S3 upload has fully propagated
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Generate presigned URL (valid for 1 year for logos)
    const logoUrl = await getPresignedDownloadUrl('receipts', storageKey, 365 * 24 * 60 * 60);

    // Update company record
    const company = await Company.findById(companyId);
    if (!company) {
      throw new Error('Company not found');
    }

    // Delete old logo if exists (just clear reference, S3 cleanup can be done separately)
    if (company.logoStorageKey && company.logoStorageKey !== storageKey) {
      try {
        logger.info({ oldStorageKey: company.logoStorageKey }, 'Old logo storage key (not deleted from S3)');
      } catch (error) {
        logger.error({ error }, 'Error handling old logo');
      }
    }

    company.logoUrl = logoUrl;
    company.logoStorageKey = storageKey;
    await company.save();

    logger.info({
      companyId,
      storageKey,
      logoUrl: logoUrl.substring(0, 50) + '...',
    }, 'Logo upload confirmed');

    return { logoUrl, logoStorageKey: storageKey };
  }

  /**
   * Get company logo URL
   * @param companyId - Company ID
   * @returns Logo URL or null
   */
  static async getLogoUrl(companyId: string): Promise<string | null> {
    const company = await Company.findById(companyId).select('logoUrl logoStorageKey').exec();

    if (!company) {
      return null;
    }

    // If logoUrl exists and is a presigned URL, return it
    if (company.logoUrl) {
      return company.logoUrl;
    }

    // If storageKey exists but no URL, generate new presigned URL
    if (company.logoStorageKey) {
      try {
        const logoUrl = await getPresignedDownloadUrl('receipts', company.logoStorageKey, 365 * 24 * 60 * 60);
        company.logoUrl = logoUrl;
        await company.save();
        return logoUrl;
      } catch (error) {
        logger.error({ error, companyId, storageKey: company.logoStorageKey }, 'Error generating logo URL');
        return null;
      }
    }

    return null;
  }

  /**
   * Delete company logo
   * @param companyId - Company ID
   */
  static async deleteLogo(companyId: string): Promise<void> {
    const company = await Company.findById(companyId);
    if (!company) {
      throw new Error('Company not found');
    }

    // Note: In production, you might want to delete the file from S3
    // For now, we'll just clear the reference
    company.logoUrl = undefined;
    company.logoStorageKey = undefined;
    await company.save();

    logger.info({ companyId }, 'Company logo deleted');
  }
}


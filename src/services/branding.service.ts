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

    // Update company record - store only storageKey, generate URL on-demand
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

    // Store only the storage key, generate presigned URL on-demand (max 7 days for S3)
    company.logoStorageKey = storageKey;
    company.logoUrl = undefined; // Clear old URL if exists, will be generated on-demand
    await company.save();

    // Generate fresh presigned URL (max 7 days for S3 Signature Version 4)
    const logoUrl = await getPresignedDownloadUrl('receipts', storageKey, 7 * 24 * 60 * 60); // 7 days

    logger.info({
      companyId,
      storageKey,
      logoUrl: logoUrl.substring(0, 50) + '...',
    }, 'Logo upload confirmed');

    return { logoUrl, logoStorageKey: storageKey };
  }

  /**
   * Get company logo URL
   * Always generates a fresh presigned URL (max 7 days expiration for S3)
   * @param companyId - Company ID
   * @returns Logo URL or null
   */
  static async getLogoUrl(companyId: string): Promise<string | null> {
    const company = await Company.findById(companyId).select('logoStorageKey').exec();

    if (!company) {
      return null;
    }

    // Always generate fresh presigned URL from storage key (max 7 days for S3 Signature Version 4)
    if (company.logoStorageKey) {
      try {
        // Generate presigned URL with 7 days expiration (max allowed by S3)
        const logoUrl = await getPresignedDownloadUrl('receipts', company.logoStorageKey, 7 * 24 * 60 * 60);
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


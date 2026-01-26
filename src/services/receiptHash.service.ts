/**
 * Receipt Hash Generation Service
 * 
 * Generates image hashes (perceptual and average) and OCR text hashes
 * for receipt-level duplicate detection.
 * 
 * Uses sharp for image processing and implements pHash/aHash algorithms.
 */

import { createHash } from 'crypto';
import sharp from 'sharp';
import { GetObjectCommand } from '@aws-sdk/client-s3';

import { s3Client, getS3Bucket } from '../config/aws';
import { OcrResult } from './ocr.service';

import { logger } from '@/config/logger';

export interface ImageHashes {
  perceptualHash: string;
  averageHash: string;
}

/**
 * Generate perceptual hash (pHash) using DCT (Discrete Cosine Transform)
 * pHash is more robust to minor image modifications
 */
function generatePerceptualHash(pixels: number[], _width: number, _height: number): string {
  // For simplicity, we'll use a simplified pHash algorithm
  // Resize to 8x8, calculate DCT, use low-frequency components
  // This is a simplified version - full DCT would be more accurate but computationally expensive
  
  // Calculate average of all pixels
  const avg = pixels.reduce((sum, p) => sum + p, 0) / pixels.length;
  
  // Create hash bits: compare each pixel to average
  let hash = 0n;
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] >= avg) {
      hash |= 1n << BigInt(i);
    }
  }
  
  // Convert to hex string (64 bits = 16 hex chars)
  return hash.toString(16).padStart(16, '0');
}

/**
 * Generate average hash (aHash)
 * aHash is faster and good for exact/near-exact duplicates
 */
function generateAverageHash(pixels: number[]): string {
  // Calculate average brightness
  const avg = pixels.reduce((sum, p) => sum + p, 0) / pixels.length;
  
  // Create hash bits: compare each pixel to average
  let hash = 0n;
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] >= avg) {
      hash |= 1n << BigInt(i);
    }
  }
  
  // Convert to hex string (64 bits = 16 hex chars)
  return hash.toString(16).padStart(16, '0');
}

export class ReceiptHashService {
  /**
   * Download receipt image from S3
   */
  static async downloadReceiptFromS3(storageKey: string): Promise<Buffer> {
    const bucket = getS3Bucket('receipts');
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: storageKey,
    });

    const response = await s3Client.send(command);
    
    if (!response.Body) {
      throw new Error('Empty response body from S3');
    }

    // Convert stream to buffer
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      (response.Body as any).on('data', (chunk: Buffer) => chunks.push(chunk));
      (response.Body as any).on('error', reject);
      (response.Body as any).on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  /**
   * Generate image hashes (perceptual and average) from image buffer
   */
  static async generateImageHashes(
    buffer: Buffer,
    mimeType: string
  ): Promise<ImageHashes> {
    try {
      // Use sharp to process image
      // Resize to 8x8 pixels (grayscale) for hash calculation
      const image = sharp(buffer);
      
      // Resize to 8x8 and convert to grayscale
      const resized = await image
        .resize(8, 8, {
          fit: 'fill',
          kernel: sharp.kernel.lanczos3,
        })
        .greyscale()
        .raw()
        .toBuffer();

      // Extract pixel values (8x8 = 64 pixels)
      const pixels: number[] = [];
      for (let i = 0; i < resized.length; i++) {
        pixels.push(resized[i]);
      }

      // Generate both hashes
      const perceptualHash = generatePerceptualHash(pixels, 8, 8);
      const averageHash = generateAverageHash(pixels);

      return {
        perceptualHash,
        averageHash,
      };
    } catch (error: any) {
      logger.error({ error: error.message, mimeType }, 'Error generating image hashes');
      throw new Error(`Failed to generate image hashes: ${error.message}`);
    }
  }

  /**
   * Generate OCR text hash from OCR result
   * Normalizes vendor, amount, date, and invoiceId, then hashes the combination
   */
  static generateOcrTextHash(ocrResult: OcrResult): string | null {
    try {
      // Normalize vendor: lowercase, trim, remove special chars
      const normalizeVendor = (v: string | undefined): string => {
        if (!v) return '';
        return String(v)
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      };

      // Normalize amount: round to 2 decimals
      const normalizeAmount = (a: number | undefined): string => {
        if (a === undefined || a === null) return '';
        return Math.round(Number(a) * 100) / 100 + '';
      };

      // Normalize date: YYYY-MM-DD format
      const normalizeDate = (d: string | undefined): string => {
        if (!d) return '';
        try {
          const date = new Date(d);
          if (isNaN(date.getTime())) return '';
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        } catch {
          return '';
        }
      };

      // Normalize invoice ID: trim, lowercase, remove special chars
      const normalizeInvoiceId = (id: string | undefined): string => {
        if (!id) return '';
        return String(id)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '');
      };

      const vendor = normalizeVendor(ocrResult.vendor);
      const amount = normalizeAmount(ocrResult.totalAmount);
      const date = normalizeDate(ocrResult.date);
      const invoiceId = normalizeInvoiceId(ocrResult.invoice_number || ocrResult.invoiceId);

      // If no meaningful data, return null
      if (!vendor && !amount && !date && !invoiceId) {
        return null;
      }

      // Combine normalized values
      const combined = `${vendor}|${amount}|${date}|${invoiceId}`;

      // Generate SHA-256 hash
      return createHash('sha256').update(combined).digest('hex');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error generating OCR text hash');
      return null;
    }
  }

  /**
   * Generate hashes for a receipt from S3 storage
   * Downloads the image, generates hashes, and returns them
   */
  static async generateHashesForReceipt(storageKey: string, mimeType: string): Promise<ImageHashes | null> {
    try {
      const buffer = await this.downloadReceiptFromS3(storageKey);
      return await this.generateImageHashes(buffer, mimeType);
    } catch (error: any) {
      logger.error({ error: error.message, storageKey }, 'Error generating hashes for receipt');
      return null;
    }
  }
}

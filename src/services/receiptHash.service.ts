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
 * 1-D DCT-II for a row of N values.
 * Returns the DCT coefficients.
 */
function dct1d(row: number[]): number[] {
  const N = row.length;
  const result: number[] = new Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += row[n] * Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
    result[k] = sum;
  }
  return result;
}

/**
 * Generate perceptual hash (pHash) using DCT (Discrete Cosine Transform)
 * Uses a 32x32 resize → 2-D DCT → top-left 8x8 low-frequency coefficients → median threshold.
 * This is significantly more discriminating than aHash for similar-looking receipts.
 */
function generatePerceptualHash(pixels: number[], width: number, height: number): string {
  // Apply 2D DCT: first along rows, then along columns
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      row.push(pixels[y * width + x]);
    }
    rows.push(dct1d(row));
  }

  // DCT along columns
  const dctMatrix: number[][] = [];
  for (let x = 0; x < width; x++) {
    const col: number[] = [];
    for (let y = 0; y < height; y++) {
      col.push(rows[y][x]);
    }
    const dctCol = dct1d(col);
    for (let y = 0; y < height; y++) {
      if (!dctMatrix[y]) dctMatrix[y] = [];
      dctMatrix[y][x] = dctCol[y];
    }
  }

  // Extract top-left 8x8 low-frequency coefficients (exclude DC at [0][0])
  const lowFreq: number[] = [];
  const size = Math.min(8, width, height);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (y === 0 && x === 0) continue; // skip DC coefficient
      lowFreq.push(dctMatrix[y][x]);
    }
  }

  // Compute median
  const sorted = [...lowFreq].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  // Create hash bits: compare each coefficient to median
  let hash = 0n;
  for (let i = 0; i < lowFreq.length && i < 64; i++) {
    if (lowFreq[i] >= median) {
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
      const image = sharp(buffer);

      // --- pHash: resize to 32x32 for DCT-based perceptual hash ---
      const resized32 = await image
        .clone()
        .resize(32, 32, {
          fit: 'fill',
          kernel: sharp.kernel.lanczos3,
        })
        .greyscale()
        .raw()
        .toBuffer();

      const pixels32: number[] = [];
      for (let i = 0; i < resized32.length; i++) {
        pixels32.push(resized32[i]);
      }
      const perceptualHash = generatePerceptualHash(pixels32, 32, 32);

      // --- aHash: resize to 8x8 for average hash ---
      const resized8 = await image
        .clone()
        .resize(8, 8, {
          fit: 'fill',
          kernel: sharp.kernel.lanczos3,
        })
        .greyscale()
        .raw()
        .toBuffer();

      const pixels8: number[] = [];
      for (let i = 0; i < resized8.length; i++) {
        pixels8.push(resized8[i]);
      }
      const averageHash = generateAverageHash(pixels8);

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

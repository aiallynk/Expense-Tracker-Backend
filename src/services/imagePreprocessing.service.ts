import sharp from 'sharp';

import { logger } from '../config/logger';

export interface PreprocessingResult {
  buffer: Buffer;
  sizeBytes: number;
  mimeType: string;
}

export class ImagePreprocessingService {
  /**
   * Preprocess image for OCR: resize, compress, strip metadata, auto-rotate
   * @param inputBuffer - Original image buffer
   * @param _mimeType - Original MIME type (unused, always outputs JPEG)
   * @returns Preprocessed buffer and metadata
   * @throws Error if image > 3MB after compression or preprocessing fails
   */
  static async preprocessImage(
    inputBuffer: Buffer,
    _mimeType: string
  ): Promise<PreprocessingResult> {
    const maxSizeBytes = 3 * 1024 * 1024; // 3MB

    try {
      // Determine output format (always JPEG for consistency and compression)
      const outputMimeType = 'image/jpeg';

      // Preprocess with Sharp
      let processedBuffer: Buffer;
      
      try {
        processedBuffer = await sharp(inputBuffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(1280, null, {
            fit: 'inside',
            withoutEnlargement: true, // Don't enlarge small images
          })
          .jpeg({
            quality: 75,
            mozjpeg: true, // Better compression
          })
          .toBuffer();
      } catch (sharpError: any) {
        logger.warn({ error: sharpError.message }, 'Sharp preprocessing failed, using original');
        // Fallback: try to convert to JPEG without resize
        processedBuffer = await sharp(inputBuffer)
          .rotate()
          .jpeg({ quality: 75 })
          .toBuffer();
      }

      // Check size after compression
      if (processedBuffer.length > maxSizeBytes) {
        throw new Error(
          `Image too large after compression: ${(processedBuffer.length / 1024 / 1024).toFixed(2)}MB (max 3MB)`
        );
      }

      return {
        buffer: processedBuffer,
        sizeBytes: processedBuffer.length,
        mimeType: outputMimeType,
      };
    } catch (error: any) {
      if (error.message?.includes('too large')) {
        throw error;
      }
      // If preprocessing fails, log and rethrow
      logger.error({ error: error.message }, 'Image preprocessing failed');
      throw new Error(`Image preprocessing failed: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Check if image needs preprocessing (size or format)
   */
  static needsPreprocessing(buffer: Buffer, mimeType: string): boolean {
    const maxSizeBytes = 3 * 1024 * 1024; // 3MB

    // Always preprocess if not JPEG
    if (!mimeType.startsWith('image/jpeg') && !mimeType.startsWith('image/jpg')) {
      return true;
    }

    // Preprocess if too large
    if (buffer.length > maxSizeBytes) {
      return true;
    }

    // Check dimensions (would need to read image metadata, but for simplicity, preprocess if large)
    // Sharp will handle this efficiently
    return false;
  }
}

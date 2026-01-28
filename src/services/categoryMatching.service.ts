import mongoose from 'mongoose';
import { Category } from '../models/Category';
import { buildFullReceiptText, inferCategoryFromReceiptText } from './ocr/ocrPostProcess.service';
import { logger } from '@/config/logger';

/**
 * Category Matching Service
 *
 * Delegates to inferCategoryFromReceiptText (AI first, then keyword fallback).
 * Used by the suggest-category API; OCR pipeline uses inferCategoryFromReceiptText directly.
 *
 * - Can be disabled via DISABLE_AI_CATEGORY_MATCHING=true env var
 * - Falls back gracefully if AI fails or is disabled
 */

export interface CategoryMatch {
  categoryId: mongoose.Types.ObjectId;
  categoryName: string;
  confidence: number;
  reasoning?: string;
}

export interface CategoryMatchingResult {
  bestMatch?: CategoryMatch;
  suggestions: CategoryMatch[];
  fallbackCategory?: CategoryMatch;
  /** True when no category could be confidently identified; app should show "Unable to identify the category. Please enter manually." */
  categoryUnidentified?: boolean;
}

export class CategoryMatchingService {
  /**
   * Find the best matching category for receipt content (AI first, then keyword fallback via inferCategoryFromReceiptText).
   */
  static async findBestCategoryMatch(
    receiptContent: {
      vendor?: string;
      lineItems?: Array<{ description: string; amount: number }>;
      notes?: string;
      extractedText?: string;
    },
    companyId?: mongoose.Types.ObjectId
  ): Promise<CategoryMatchingResult> {
    try {
      const receiptLike = {
        vendor: receiptContent.vendor,
        lineItems: receiptContent.lineItems,
        notes: receiptContent.notes ?? receiptContent.extractedText,
      };
      const fullText = buildFullReceiptText(receiptLike);
      const result = await inferCategoryFromReceiptText(fullText, companyId, {
        vendorText: receiptContent.vendor ?? undefined,
      });

      if (!result.categoryUnidentified && result.categoryId && result.categorySuggestion) {
        const confidencePercent =
          result.confidence !== undefined ? Math.round(result.confidence * 100) : 80;
        const bestMatch: CategoryMatch = {
          categoryId: result.categoryId,
          categoryName: result.categorySuggestion,
          confidence: confidencePercent,
          reasoning: result.confidence !== undefined ? 'AI/keyword inference' : 'Keyword match from receipt text',
        };
        logger.info({
          companyId,
          bestMatch: bestMatch.categoryName,
          confidence: bestMatch.confidence,
        }, 'Category matching completed');
        return {
          bestMatch,
          suggestions: [bestMatch],
          categoryUnidentified: false,
        };
      }

      const fallback = await this.getFallbackCategory(companyId);
      return { ...fallback, categoryUnidentified: true };
    } catch (error: any) {
      logger.error({
        error: error.message,
        companyId,
        receiptContent: JSON.stringify(receiptContent).substring(0, 200),
      }, 'Category matching failed, using fallback');

      const fallback = await this.getFallbackCategory(companyId);
      return { ...fallback, categoryUnidentified: true };
    }
  }

  /**
   * Get fallback category when inference fails or returns unidentified
   */
  private static async getFallbackCategory(companyId?: mongoose.Types.ObjectId): Promise<CategoryMatchingResult> {
    try {
      // Try to find a generic "Other" or "Miscellaneous" category
      const fallbackCategory = await Category.findOne({
        name: { $regex: /^(Other|Others|Miscellaneous|Misc|General)$/i },
        status: 'ACTIVE',
        $or: [
          { companyId: null },
          { companyId }
        ]
      }).select('name _id').lean();

      if (fallbackCategory) {
        const match: CategoryMatch = {
          categoryId: fallbackCategory._id as mongoose.Types.ObjectId,
          categoryName: fallbackCategory.name,
          confidence: 10, // Low confidence for fallback
          reasoning: 'Fallback category - AI matching failed'
        };

        return {
          suggestions: [match],
          fallbackCategory: match
        };
      }
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Failed to get fallback category');
    }

    // Return empty result if no fallback category found
    return { suggestions: [] };
  }
}
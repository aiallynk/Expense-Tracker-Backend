import mongoose from 'mongoose';
import { openaiClient } from '../config/openai';
import { Category } from '../models/Category';
import { config } from '../config/index';
import { logger } from '@/config/logger';

/**
 * AI-Powered Category Matching Service
 *
 * This service enhances OCR receipt processing by intelligently matching
 * extracted receipt content to appropriate expense categories using AI.
 *
 * Key Features:
 * - Dynamic category fetching (system + company-specific categories)
 * - AI-based content analysis using OpenAI GPT
 * - Confidence scoring and fallback logic
 * - Non-breaking enhancement (preserves existing behavior)
 * - Timeout protection and error handling
 *
 * Usage:
 * - Automatically called during OCR processing for draft expenses
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
}

export class CategoryMatchingService {
  /**
   * Find the best matching category for receipt content using AI
   * This is a safe, non-breaking enhancement that preserves existing behavior
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
      // Check if AI category matching is disabled
      if (config.ai?.disableCategoryMatching) {
        logger.info({ companyId }, 'AI category matching is disabled, using fallback');
        return this.getFallbackCategory(companyId);
      }

      // Fetch all active categories for the company
      const categories = await Category.find({
        status: 'ACTIVE',
        $or: [
          { companyId: null }, // System categories
          { companyId } // Company-specific categories
        ]
      }).select('name description').lean() as unknown as Array<{ name: string; description?: string; _id: mongoose.Types.ObjectId }>;

      if (categories.length === 0) {
        logger.warn({ companyId }, 'No categories found for category matching');
        return { suggestions: [] };
      }

      // Prepare receipt content for AI analysis
      const contentText = this.prepareReceiptContentForAI(receiptContent);

      // Use AI to find best category match
      const aiResult = await this.callCategoryMatchingAI(contentText, categories);

      // Process AI result and create structured response
      const result = this.processAIResult(aiResult, categories);

      logger.info({
        companyId,
        bestMatch: result.bestMatch?.categoryName,
        confidence: result.bestMatch?.confidence,
        suggestionsCount: result.suggestions.length
      }, 'Category matching completed');

      return result;
    } catch (error: any) {
      logger.error({
        error: error.message,
        companyId,
        receiptContent: JSON.stringify(receiptContent).substring(0, 200)
      }, 'Category matching failed, using fallback');

      // Return fallback result on error
      return await this.getFallbackCategory(companyId);
    }
  }

  /**
   * Prepare receipt content for AI analysis
   */
  private static prepareReceiptContentForAI(content: {
    vendor?: string;
    lineItems?: Array<{ description: string; amount: number }>;
    notes?: string;
    extractedText?: string;
  }): string {
    const parts: string[] = [];

    if (content.vendor) {
      parts.push(`Vendor/Merchant: ${content.vendor}`);
    }

    if (content.lineItems && content.lineItems.length > 0) {
      const itemsText = content.lineItems
        .map(item => `${item.description || 'Item'} (${item.amount || 0})`)
        .join(', ');
      parts.push(`Items: ${itemsText}`);
    }

    if (content.notes) {
      parts.push(`Notes: ${content.notes}`);
    }

    if (content.extractedText) {
      // Include first 500 characters of extracted text for context
      const truncatedText = content.extractedText.substring(0, 500);
      if (truncatedText.trim()) {
        parts.push(`Receipt Text: ${truncatedText}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Call OpenAI for category matching
   */
  private static async callCategoryMatchingAI(
    contentText: string,
    categories: Array<{ name: string; description?: string; _id: mongoose.Types.ObjectId }>
  ): Promise<any> {
    const categoriesList = categories
      .map(cat => `${cat.name}${cat.description ? ` (${cat.description})` : ''}`)
      .join(', ');

    const prompt = `Analyze this receipt content and suggest the BEST matching expense category.

Receipt Content:
${contentText}

Available Categories:
${categoriesList}

Instructions:
1. Choose the SINGLE best matching category from the available categories list
2. If no category matches well (confidence < 60%), respond with "Uncategorized"
3. Provide confidence score (0-100)
4. Give brief reasoning for your choice
5. NEVER invent new categories - only choose from the provided list

Return JSON format:
{
  "category": "CategoryName",
  "confidence": 85,
  "reasoning": "Brief explanation"
}`;

    try {
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI matching timeout')), 10000) // 10 second timeout
      );

      const aiPromise = openaiClient.chat.completions.create({
        model: 'gpt-4o-mini', // Use cost-effective model for this task
        messages: [
          {
            role: 'system',
            content: 'You are an expert at categorizing business expenses. Analyze receipt content and match it to the most appropriate expense category.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 300,
        temperature: 0.1, // Low temperature for consistent results
        response_format: { type: 'json_object' }
      });

      const response = await Promise.race([aiPromise, timeoutPromise]) as any;

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      return JSON.parse(content);
    } catch (error: any) {
      logger.error({
        error: error.message,
        contentLength: contentText.length,
        categoriesCount: categories.length
      }, 'OpenAI category matching failed');
      throw error;
    }
  }

  /**
   * Process AI result and create structured response
   */
  private static processAIResult(
    aiResult: any,
    categories: Array<{ name: string; description?: string; _id: mongoose.Types.ObjectId }>
  ): CategoryMatchingResult {
    const suggestions: CategoryMatch[] = [];

    // Find the matched category
    if (aiResult.category && aiResult.category !== 'Uncategorized') {
      const matchedCategory = categories.find(cat =>
        cat.name.toLowerCase() === aiResult.category.toLowerCase()
      );

      if (matchedCategory) {
        const confidence = Math.min(100, Math.max(0, aiResult.confidence || 0));

        const bestMatch: CategoryMatch = {
          categoryId: matchedCategory._id as mongoose.Types.ObjectId,
          categoryName: matchedCategory.name,
          confidence,
          reasoning: aiResult.reasoning
        };

        suggestions.push(bestMatch);

        return {
          bestMatch,
          suggestions
        };
      }
    }

    // If no good match found, return suggestions with low confidence
    // Try basic keyword matching as fallback
    const contentText = aiResult.receiptContent || '';
    const keywordMatches = this.findKeywordMatches(contentText, categories);

    return {
      suggestions: keywordMatches,
      fallbackCategory: keywordMatches.length > 0 ? keywordMatches[0] : undefined
    };
  }

  /**
   * Basic keyword matching as fallback
   */
  private static findKeywordMatches(
    content: string,
    categories: Array<{ name: string; description?: string; _id: mongoose.Types.ObjectId }>
  ): CategoryMatch[] {
    const contentLower = content.toLowerCase();
    const matches: Array<{ category: any; score: number }> = [];

    for (const category of categories) {
      let score = 0;

      // Check category name
      const nameLower = category.name.toLowerCase();
      if (contentLower.includes(nameLower)) {
        score += 50; // High score for exact name match
      } else if (nameLower.split(' ').some(word => contentLower.includes(word))) {
        score += 20; // Medium score for partial word match
      }

      // Check description
      if (category.description) {
        const descLower = category.description.toLowerCase();
        if (contentLower.includes(descLower)) {
          score += 30;
        } else if (descLower.split(' ').some(word => contentLower.includes(word))) {
          score += 10;
        }
      }

      if (score > 0) {
        matches.push({ category, score });
      }
    }

    // Sort by score and return top matches
    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, 3) // Top 3 matches
      .map(match => ({
        categoryId: match.category._id as mongoose.Types.ObjectId,
        categoryName: match.category.name,
        confidence: Math.min(100, match.score),
        reasoning: 'Keyword match fallback'
      }));
  }

  /**
   * Get fallback category when AI matching fails
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
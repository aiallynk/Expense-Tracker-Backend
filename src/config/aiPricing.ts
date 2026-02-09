/**
 * AI model pricing configuration (USD per 1K tokens)
 * Cost = (promptTokens * inputPricePer1k/1000) + (completionTokens * outputPricePer1k/1000)
 * Pricing is changeable via env AI_PRICING_OVERRIDE (JSON string) without code changes)
 */

export interface ModelPricing {
  inputPricePer1k: number; // USD per 1000 input tokens
  outputPricePer1k: number; // USD per 1000 output tokens
}

// Default pricing (OpenAI as of 2024 - GPT-4o-mini, gpt-4o)
// https://platform.openai.com/docs/pricing
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'gpt-4o-mini': {
    inputPricePer1k: 0.00015, // $0.15/1M = $0.00015/1K
    outputPricePer1k: 0.0006, // $0.60/1M = $0.0006/1K
  },
  'gpt-4o': {
    inputPricePer1k: 0.0025, // $2.50/1M = $0.0025/1K
    outputPricePer1k: 0.01, // $10/1M = $0.01/1K
  },
  'gpt-4-turbo': {
    inputPricePer1k: 0.01,
    outputPricePer1k: 0.03,
  },
  'gpt-4': {
    inputPricePer1k: 0.03,
    outputPricePer1k: 0.06,
  },
  'gpt-3.5-turbo': {
    inputPricePer1k: 0.0005,
    outputPricePer1k: 0.0015,
  },
};

let pricingMap: Record<string, ModelPricing> = { ...DEFAULT_PRICING };

/**
 * Load pricing from env override (JSON string)
 * Format: {"gpt-4o-mini":{"inputPricePer1k":0.00015,"outputPricePer1k":0.0006},...}
 */
function loadPricingOverride(): void {
  const override = process.env.AI_PRICING_OVERRIDE;
  if (!override?.trim()) return;
  try {
    const parsed = JSON.parse(override) as Record<string, ModelPricing>;
    if (typeof parsed === 'object' && parsed !== null) {
      Object.assign(pricingMap, parsed);
    }
  } catch {
    // Silently ignore invalid JSON
  }
}

loadPricingOverride();

/**
 * Get pricing for a model. Falls back to gpt-4o-mini if model not found.
 */
export function getModelPricing(model: string): ModelPricing {
  const normalized = model?.toLowerCase?.() || model;
  return pricingMap[normalized] ?? pricingMap['gpt-4o-mini'] ?? DEFAULT_PRICING['gpt-4o-mini'];
}

/**
 * Calculate cost in USD for a given token usage
 */
export function calculateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const p = getModelPricing(model);
  const inputCost = (promptTokens / 1000) * p.inputPricePer1k;
  const outputCost = (completionTokens / 1000) * p.outputPricePer1k;
  return Math.round((inputCost + outputCost) * 100000000) / 100000000; // round to 8 decimals
}

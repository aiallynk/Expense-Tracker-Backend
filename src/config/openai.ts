import OpenAI from 'openai';
import { config } from './index';
import { logger } from '../utils/logger';

// Together AI uses OpenAI-compatible API
export const togetherAIClient = new OpenAI({
  apiKey: config.togetherAI.apiKey,
  baseURL: config.togetherAI.baseUrl,
  defaultHeaders: {
    ...(config.togetherAI.userKey && { 'X-Together-User-Key': config.togetherAI.userKey }),
  },
});

// Log configuration on initialization
if (config.togetherAI.apiKey) {
  logger.info('Together AI configured', {
    model: config.togetherAI.modelVision,
    baseUrl: config.togetherAI.baseUrl,
    hasUserKey: !!config.togetherAI.userKey,
  });
} else {
  logger.warn('Together AI API key not configured');
}

export const getVisionModel = (): string => {
  return config.togetherAI.modelVision;
};

// Legacy exports for compatibility
export const openaiClient = togetherAIClient;
export const getTextModel = (): string => {
  return config.togetherAI.modelVision; // Use same model for text
};


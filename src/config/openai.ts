import OpenAI from 'openai';

import { logger } from './logger';

import { config } from './index';

// Initialize OpenAI Client (for Vision & Text)
export const openaiClient = new OpenAI({
  apiKey: config.openai.apiKey,
  baseURL: config.openai.baseUrl,
});

export const getVisionModel = (): string => {
  return config.openai.modelVision;
};

export const getTextModel = (): string => {
  return config.openai.modelVision; // Use vision model by default unless you want a specific text model
};

// Log config usage on startup
if (config.openai.apiKey) {
  logger.info({ model: config.openai.modelVision, using: 'OpenAI', baseUrl: config.openai.baseUrl }, 'OpenAI API configured');
} else {
  logger.warn('OpenAI API key not configured');
}

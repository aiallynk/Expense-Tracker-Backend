import OpenAI from 'openai';
import { config } from './index';

export const openaiClient = new OpenAI({
  apiKey: config.openai.apiKey,
});

export const getVisionModel = (): string => {
  return config.openai.modelVision;
};

export const getTextModel = (): string => {
  return config.openai.modelText;
};


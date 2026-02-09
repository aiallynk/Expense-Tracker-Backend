/**
 * Central OpenAI Wrapper Service
 * - Single entry point for all OpenAI API calls
 * - Extracts usage from response.usage
 * - Persists to ai_token_usage, increments Redis, emits WebSocket event
 * - OpenAI API key never exposed to frontend
 */

import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';

import { openaiClient } from '../config/openai';
import { AiFeature } from '../utils/enums';
import { recordUsage, buildUsageRecord } from './aiTokenUsage.service';
import { emitAiUsageUpdate } from '../socket/realtimeEvents';
import { logger } from '@/config/logger';

export interface CallOpenAIOptions {
  companyId: string;
  userId: string;
  feature: AiFeature | 'OCR' | 'CHAT' | 'SUMMARY' | 'AI_ASSIST';
  model: string;
  messages: ChatCompletionMessageParam[];
  max_tokens?: number;
  temperature?: number;
  response_format?: ChatCompletionCreateParamsNonStreaming['response_format'];
  [key: string]: unknown;
}

/**
 * Call OpenAI Chat Completions API with usage tracking.
 * All OpenAI requests must pass through this wrapper.
 */
export async function callOpenAI(options: CallOpenAIOptions): Promise<ChatCompletion> {
  const { companyId, userId, feature, model, messages, ...rest } = options;

  const requestOptions: ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    ...rest,
  };

  const response = await openaiClient.chat.completions.create(requestOptions);

  const usage = response.usage;
  if (usage) {
    const record = buildUsageRecord(
      companyId,
      userId,
      feature,
      model,
      usage,
      response.id ?? undefined
    );

    // Persist and increment Redis (non-blocking)
    recordUsage(record).catch((err) => {
      logger.error({ error: err, record }, 'Failed to record AI usage');
    });

    // Emit real-time event to Super Admin
    emitAiUsageUpdate({
      companyId,
      feature,
      model,
      totalTokens: record.totalTokens,
      costUsd: record.costUsd,
      timestamp: new Date().toISOString(),
    });
  }

  return response;
}

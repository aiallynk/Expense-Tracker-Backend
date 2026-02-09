/**
 * AI Token Usage Service
 * - Persists usage to MongoDB (source of truth)
 * - Increments Redis counters for real-time analytics
 * - Provides aggregation APIs for Super Admin
 */

import type { ChatCompletion } from 'openai/resources/chat/completions';

import { AiTokenUsage } from '../models/AiTokenUsage';
import { redisConnection, isRedisAvailable } from '../config/queue';
import { calculateCostUsd } from '../config/aiPricing';
import { AiFeature } from '../utils/enums';
import { logger } from '@/config/logger';

/** Usage record for persistence */
export interface AiUsageRecord {
  companyId: string;
  userId: string;
  feature: AiFeature | string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  requestId?: string;
}

/** Redis key helpers - use date suffix for today/month boundaries */
function getTodayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function getMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Increment Redis counters atomically (non-blocking, fire-and-forget) */
async function incrementRedisCounters(companyId: string, totalTokens: number, costUsd: number): Promise<void> {
  if (!isRedisAvailable() || !redisConnection) return;

  const today = getTodayKey();
  const month = getMonthKey();

  const keys = [
    `ai:company:${companyId}:tokens:today:${today}`,
    `ai:company:${companyId}:tokens:month:${month}`,
    `ai:platform:tokens:today:${today}`,
    `ai:platform:tokens:month:${month}`,
    `ai:platform:cost:today:${today}`,
    `ai:platform:cost:month:${month}`,
  ];

  try {
    const pipeline = redisConnection.pipeline();
    pipeline.incrby(keys[0], totalTokens);
    pipeline.incrby(keys[1], totalTokens);
    pipeline.incrby(keys[2], totalTokens);
    pipeline.incrby(keys[3], totalTokens);
    pipeline.incrbyfloat(keys[4], costUsd);
    pipeline.incrbyfloat(keys[5], costUsd);
    // TTL: today keys expire after 2 days, month keys after 35 days
    pipeline.expire(keys[0], 172800);
    pipeline.expire(keys[1], 3024000);
    pipeline.expire(keys[2], 172800);
    pipeline.expire(keys[3], 3024000);
    pipeline.expire(keys[4], 172800);
    pipeline.expire(keys[5], 3024000);
    await pipeline.exec();
  } catch (err) {
    logger.warn({ error: err }, 'Failed to increment AI usage Redis counters');
  }
}

/** Persist usage record and increment Redis (non-blocking) */
export async function recordUsage(record: AiUsageRecord): Promise<void> {
  try {
    await AiTokenUsage.create({
      companyId: record.companyId,
      userId: record.userId,
      feature: record.feature,
      model: record.model,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      totalTokens: record.totalTokens,
      costUsd: record.costUsd,
      requestId: record.requestId,
    });
  } catch (err) {
    logger.error({ error: err, record }, 'Failed to persist AI token usage');
    return;
  }

  incrementRedisCounters(record.companyId, record.totalTokens, record.costUsd).catch(() => {});
}

/** Get Redis counters for today/month (instant snapshot) - internal */
async function getRedisSnapshotInternal(): Promise<{
  tokensToday: number;
  tokensMonth: number;
  costToday: number;
  costMonth: number;
} | null> {
  if (!isRedisAvailable() || !redisConnection) return null;

  const today = getTodayKey();
  const month = getMonthKey();

  try {
    const [tokensToday, tokensMonth, costToday, costMonth] = await Promise.all([
      redisConnection.get(`ai:platform:tokens:today:${today}`),
      redisConnection.get(`ai:platform:tokens:month:${month}`),
      redisConnection.get(`ai:platform:cost:today:${today}`),
      redisConnection.get(`ai:platform:cost:month:${month}`),
    ]);
    return {
      tokensToday: parseInt(tokensToday || '0', 10),
      tokensMonth: parseInt(tokensMonth || '0', 10),
      costToday: parseFloat(costToday || '0'),
      costMonth: parseFloat(costMonth || '0'),
    };
  } catch {
    return null;
  }
}

/** Get Redis-only snapshot for instant UI (no DB queries) */
export async function getSnapshot(): Promise<{
  tokensToday: number;
  tokensMonth: number;
  costToday: number;
  costMonth: number;
  generatedAt: string;
  dataSource: 'REDIS';
}> {
  const generatedAt = new Date().toISOString();
  const snap = await getRedisSnapshotInternal();
  if (snap) {
    return {
      ...snap,
      generatedAt,
      dataSource: 'REDIS',
    };
  }
  return {
    tokensToday: 0,
    tokensMonth: 0,
    costToday: 0,
    costMonth: 0,
    generatedAt,
    dataSource: 'REDIS',
  };
}

/** Time range for aggregations */
export type TimeRange = 'today' | '7d' | '30d' | '90d' | 'lifetime';

function getDateRange(timeRange: TimeRange): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date();
  switch (timeRange) {
    case 'today':
      start.setUTCHours(0, 0, 0, 0);
      break;
    case '7d':
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      break;
    case '90d':
      start.setDate(start.getDate() - 90);
      break;
    case 'lifetime':
      start.setTime(0);
      break;
    default:
      start.setDate(start.getDate() - 30);
  }
  return { start, end };
}

/** Get summary - use Redis for instant today/month, DB for lifetime */
export async function getSummary(_timeRange: TimeRange = '30d'): Promise<{
  tokensToday: number;
  tokensMonth: number;
  tokensLifetime: number;
  costUsdToday: number;
  costUsdMonth: number;
  costUsdLifetime: number;
  generatedAt: string;
  dataSource: 'LIVE_DB' | 'REDIS' | 'HYBRID';
  confidence: 'REALTIME';
}> {
  const generatedAt = new Date().toISOString();
  const redisSnap = await getRedisSnapshotInternal();

  const { start: startToday } = getDateRange('today');
  const startMonthDate = new Date();
  startMonthDate.setDate(startMonthDate.getDate() - 30);

  const [todayAgg, monthAgg, lifetimeAgg] = await Promise.all([
    AiTokenUsage.aggregate([
      { $match: { createdAt: { $gte: startToday } } },
      { $group: { _id: null, tokens: { $sum: '$totalTokens' }, cost: { $sum: '$costUsd' } } },
    ]),
    AiTokenUsage.aggregate([
      { $match: { createdAt: { $gte: startMonthDate } } },
      { $group: { _id: null, tokens: { $sum: '$totalTokens' }, cost: { $sum: '$costUsd' } } },
    ]),
    AiTokenUsage.aggregate([
      { $group: { _id: null, tokens: { $sum: '$totalTokens' }, cost: { $sum: '$costUsd' } } },
    ]),
  ]);

  const dbToday = todayAgg[0] ?? { tokens: 0, cost: 0 };
  const dbMonth = monthAgg[0] ?? { tokens: 0, cost: 0 };
  const dbLifetime = lifetimeAgg[0] ?? { tokens: 0, cost: 0 };

  let dataSource: 'LIVE_DB' | 'REDIS' | 'HYBRID' = 'LIVE_DB';
  const tokensToday = redisSnap ? redisSnap.tokensToday : dbToday.tokens;
  const tokensMonth = redisSnap ? redisSnap.tokensMonth : dbMonth.tokens;
  const costUsdToday = redisSnap ? redisSnap.costToday : dbToday.cost;
  const costUsdMonth = redisSnap ? redisSnap.costMonth : dbMonth.cost;

  if (redisSnap) {
    dataSource = 'HYBRID';
  }

  return {
    tokensToday,
    tokensMonth,
    tokensLifetime: dbLifetime.tokens,
    costUsdToday,
    costUsdMonth,
    costUsdLifetime: dbLifetime.cost,
    generatedAt,
    dataSource,
    confidence: 'REALTIME',
  };
}

/** Top companies by token usage */
export async function getTopCompanies(limit = 10, timeRange: TimeRange = '30d'): Promise<{
  companies: Array<{ companyId: string; totalTokens: number; costUsd: number }>;
  generatedAt: string;
  dataSource: 'LIVE_DB';
  confidence: 'REALTIME';
}> {
  const { start } = getDateRange(timeRange);
  const agg = await AiTokenUsage.aggregate([
    { $match: { createdAt: { $gte: start } } },
    { $group: { _id: '$companyId', totalTokens: { $sum: '$totalTokens' }, costUsd: { $sum: '$costUsd' } } },
    { $sort: { totalTokens: -1 } },
    { $limit: limit },
    { $project: { companyId: '$_id', totalTokens: 1, costUsd: 1, _id: 0 } },
  ]);

  return {
    companies: agg,
    generatedAt: new Date().toISOString(),
    dataSource: 'LIVE_DB',
    confidence: 'REALTIME',
  };
}

/** Usage by feature */
export async function getByFeature(timeRange: TimeRange = '30d'): Promise<{
  features: Array<{ feature: string; totalTokens: number; costUsd: number }>;
  generatedAt: string;
  dataSource: 'LIVE_DB';
  confidence: 'REALTIME';
}> {
  const { start } = getDateRange(timeRange);
  const agg = await AiTokenUsage.aggregate([
    { $match: { createdAt: { $gte: start } } },
    { $group: { _id: '$feature', totalTokens: { $sum: '$totalTokens' }, costUsd: { $sum: '$costUsd' } } },
    { $sort: { totalTokens: -1 } },
    { $project: { feature: '$_id', totalTokens: 1, costUsd: 1, _id: 0 } },
  ]);

  return {
    features: agg,
    generatedAt: new Date().toISOString(),
    dataSource: 'LIVE_DB',
    confidence: 'REALTIME',
  };
}

/** Usage by model */
export async function getByModel(timeRange: TimeRange = '30d'): Promise<{
  models: Array<{ model: string; totalTokens: number; costUsd: number }>;
  generatedAt: string;
  dataSource: 'LIVE_DB';
  confidence: 'REALTIME';
}> {
  const { start } = getDateRange(timeRange);
  const agg = await AiTokenUsage.aggregate([
    { $match: { createdAt: { $gte: start } } },
    { $group: { _id: '$model', totalTokens: { $sum: '$totalTokens' }, costUsd: { $sum: '$costUsd' } } },
    { $sort: { totalTokens: -1 } },
    { $project: { model: '$_id', totalTokens: 1, costUsd: 1, _id: 0 } },
  ]);

  return {
    models: agg,
    generatedAt: new Date().toISOString(),
    dataSource: 'LIVE_DB',
    confidence: 'REALTIME',
  };
}

/** Usage trends (daily aggregation) */
export async function getTrends(timeRange: TimeRange = '30d'): Promise<{
  trends: Array<{ date: string; totalTokens: number; costUsd: number }>;
  generatedAt: string;
  dataSource: 'LIVE_DB';
  confidence: 'REALTIME';
}> {
  const { start } = getDateRange(timeRange);
  const agg = await AiTokenUsage.aggregate([
    { $match: { createdAt: { $gte: start } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        totalTokens: { $sum: '$totalTokens' },
        costUsd: { $sum: '$costUsd' },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { date: '$_id', totalTokens: 1, costUsd: 1, _id: 0 } },
  ]);

  return {
    trends: agg,
    generatedAt: new Date().toISOString(),
    dataSource: 'LIVE_DB',
    confidence: 'REALTIME',
  };
}

/** Helper to build AiUsageRecord from OpenAI response */
export function buildUsageRecord(
  companyId: string,
  userId: string,
  feature: AiFeature | string,
  model: string,
  usage: NonNullable<ChatCompletion['usage']>,
  requestId?: string
): AiUsageRecord {
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  const costUsd = calculateCostUsd(model, promptTokens, completionTokens);

  return {
    companyId,
    userId,
    feature,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
    requestId,
  };
}

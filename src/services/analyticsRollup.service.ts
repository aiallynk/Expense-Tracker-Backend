import mongoose from 'mongoose';

import { logger } from '@/config/logger';

import { isRedisAvailable } from '../config/queue';
import { ApiAnalytics } from '../models/ApiAnalytics';
import { ApiRequestLog } from '../models/ApiRequestLog';
import { CompanyLimits } from '../models/CompanyLimits';
import { CompanyUsage } from '../models/CompanyUsage';
import { CompanyUsageMetrics } from '../models/CompanyUsageMetrics';
import { ErrorAnalytics } from '../models/ErrorAnalytics';
import { OcrJob } from '../models/OcrJob';
import { SystemMetrics } from '../models/SystemMetrics';
import { OcrJobStatus } from '../utils/enums';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function calculatePercentile(values: number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function calculateUsagePercent(used: number, max: number): number {
  if (!max || max <= 0) return 0;
  return round2((used / max) * 100);
}

export class AnalyticsRollupService {
  private static readonly BUCKET_MS = 5 * 60 * 1000;

  static floorToFiveMinuteBucket(date: Date): Date {
    const timestamp = date.getTime();
    const floored = Math.floor(timestamp / this.BUCKET_MS) * this.BUCKET_MS;
    return new Date(floored);
  }

  static getLatestCompletedBucket(): { bucketStart: Date; bucketEnd: Date } {
    const bucketEnd = this.floorToFiveMinuteBucket(new Date());
    const bucketStart = new Date(bucketEnd.getTime() - this.BUCKET_MS);
    return { bucketStart, bucketEnd };
  }

  static async rollupLatestBucket(): Promise<void> {
    const { bucketStart, bucketEnd } = this.getLatestCompletedBucket();
    await this.rollupBucket(bucketStart, bucketEnd);
  }

  static async rollupBucket(bucketStart: Date, bucketEnd: Date): Promise<void> {
    if (bucketStart >= bucketEnd) return;

    await Promise.all([
      this.rollupApiAnalytics(bucketStart, bucketEnd),
      this.rollupErrorAnalytics(bucketStart, bucketEnd),
      this.rollupSystemMetrics(bucketStart, bucketEnd),
      this.rollupCompanyUsageMetrics(bucketStart, bucketEnd),
    ]);

    logger.debug(
      {
        bucketStart: bucketStart.toISOString(),
        bucketEnd: bucketEnd.toISOString(),
      },
      'Analytics rollup completed'
    );
  }

  private static async rollupApiAnalytics(bucketStart: Date, bucketEnd: Date): Promise<void> {
    const grouped = await ApiRequestLog.aggregate([
      {
        $match: {
          createdAt: { $gte: bucketStart, $lt: bucketEnd },
        },
      },
      {
        $addFields: {
          statusGroup: {
            $switch: {
              branches: [
                { case: { $gte: ['$statusCode', 500] }, then: '5xx' },
                { case: { $gte: ['$statusCode', 400] }, then: '4xx' },
                { case: { $gte: ['$statusCode', 200] }, then: '2xx' },
              ],
              default: 'other',
            },
          },
        },
      },
      {
        $group: {
          _id: {
            method: '$method',
            path: '$path',
            statusGroup: '$statusGroup',
            companyId: '$companyId',
          },
          requestCount: { $sum: 1 },
          errorCount: {
            $sum: {
              $cond: [{ $gte: ['$statusCode', 400] }, 1, 0],
            },
          },
          avgResponseTime: { $avg: '$responseTime' },
          responseTimes: { $push: '$responseTime' },
        },
      },
    ]).exec();

    if (!grouped.length) return;

    const operations = grouped.map((entry) => {
      const p95ResponseTime = round2(calculatePercentile(entry.responseTimes || [], 95));
      return {
        updateOne: {
          filter: {
            bucketStart,
            bucketEnd,
            method: entry._id.method,
            path: entry._id.path,
            statusGroup: entry._id.statusGroup,
            companyId: entry._id.companyId || null,
          },
          update: {
            $set: {
              bucketStart,
              bucketEnd,
              method: entry._id.method,
              path: entry._id.path,
              statusGroup: entry._id.statusGroup,
              companyId: entry._id.companyId || null,
              requestCount: entry.requestCount || 0,
              errorCount: entry.errorCount || 0,
              avgResponseTime: round2(entry.avgResponseTime || 0),
              p95ResponseTime,
            },
          },
          upsert: true,
        },
      };
    });

    if (operations.length) {
      await ApiAnalytics.bulkWrite(operations, { ordered: false });
    }
  }

  private static async rollupErrorAnalytics(bucketStart: Date, bucketEnd: Date): Promise<void> {
    const grouped = await ApiRequestLog.aggregate([
      {
        $match: {
          createdAt: { $gte: bucketStart, $lt: bucketEnd },
          statusCode: { $gte: 400 },
        },
      },
      {
        $group: {
          _id: {
            path: '$path',
            statusCode: '$statusCode',
            companyId: '$companyId',
          },
          errorCount: { $sum: 1 },
        },
      },
    ]).exec();

    if (!grouped.length) return;

    const operations = grouped.map((entry) => ({
      updateOne: {
        filter: {
          bucketStart,
          bucketEnd,
          path: entry._id.path,
          statusCode: entry._id.statusCode,
          companyId: entry._id.companyId || null,
        },
        update: {
          $set: {
            bucketStart,
            bucketEnd,
            path: entry._id.path,
            statusCode: entry._id.statusCode,
            companyId: entry._id.companyId || null,
            errorCount: entry.errorCount || 0,
          },
        },
        upsert: true,
      },
    }));

    if (operations.length) {
      await ErrorAnalytics.bulkWrite(operations, { ordered: false });
    }
  }

  private static async rollupSystemMetrics(bucketStart: Date, bucketEnd: Date): Promise<void> {
    const summary = await ApiRequestLog.aggregate([
      {
        $match: {
          createdAt: { $gte: bucketStart, $lt: bucketEnd },
        },
      },
      {
        $group: {
          _id: null,
          apiRequests: { $sum: 1 },
          errorRequests: {
            $sum: {
              $cond: [{ $gte: ['$statusCode', 400] }, 1, 0],
            },
          },
          avgResponseTime: { $avg: '$responseTime' },
          responseTimes: { $push: '$responseTime' },
        },
      },
    ]).exec();

    const aggregateSummary = summary[0];
    const apiRequests = aggregateSummary?.apiRequests || 0;
    const errorRequests = aggregateSummary?.errorRequests || 0;
    const avgResponseTime = round2(aggregateSummary?.avgResponseTime || 0);
    const p95ResponseTime = round2(calculatePercentile(aggregateSummary?.responseTimes || [], 95));
    const ocrQueueDepth = await OcrJob.countDocuments({
      status: { $in: [OcrJobStatus.QUEUED, OcrJobStatus.PROCESSING] },
    });

    await SystemMetrics.findOneAndUpdate(
      { bucketStart, bucketEnd },
      {
        $set: {
          bucketStart,
          bucketEnd,
          apiRequests,
          errorRequests,
          avgResponseTime,
          p95ResponseTime,
          ocrQueueDepth,
          dbConnected: mongoose.connection.readyState === 1,
          redisConnected: isRedisAvailable(),
        },
      },
      { upsert: true, new: true }
    ).exec();
  }

  private static async rollupCompanyUsageMetrics(bucketStart: Date, bucketEnd: Date): Promise<void> {
    const usages = await CompanyUsage.find({}).lean();
    if (!usages.length) return;

    const companyIds = usages.map((usage) => usage.companyId);
    const limits = await CompanyLimits.find({ companyId: { $in: companyIds } }).lean();
    const limitsMap = new Map(limits.map((limit) => [limit.companyId.toString(), limit]));

    const operations = usages.map((usage) => {
      const companyId = usage.companyId.toString();
      const limit = limitsMap.get(companyId);
      const maxExpenses = limit?.maxExpenses || 0;
      const maxReports = limit?.maxReports || 0;
      const expenseUsagePct = calculateUsagePercent(usage.expensesUsed || 0, maxExpenses);
      const reportUsagePct = calculateUsagePercent(usage.reportsUsed || 0, maxReports);
      const limitedExpenseUsed = maxExpenses > 0 ? usage.expensesUsed || 0 : 0;
      const limitedReportUsed = maxReports > 0 ? usage.reportsUsed || 0 : 0;
      const combinedMax = (maxExpenses > 0 ? maxExpenses : 0) + (maxReports > 0 ? maxReports : 0);
      const maxUsagePct =
        combinedMax > 0
          ? Math.min(100, round2(((limitedExpenseUsed + limitedReportUsed) / combinedMax) * 100))
          : 0;

      return {
        updateOne: {
          filter: { companyId: usage.companyId, bucketStart, bucketEnd },
          update: {
            $set: {
              companyId: usage.companyId,
              bucketStart,
              bucketEnd,
              expensesUsed: usage.expensesUsed || 0,
              reportsUsed: usage.reportsUsed || 0,
              maxExpenses,
              maxReports,
              expenseUsagePct,
              reportUsagePct,
              maxUsagePct,
            },
          },
          upsert: true,
        },
      };
    });

    if (operations.length) {
      await CompanyUsageMetrics.bulkWrite(operations, { ordered: false });
    }
  }
}

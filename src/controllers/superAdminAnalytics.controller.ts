import { Response } from 'express';
import mongoose from 'mongoose';

import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { ApiAnalytics } from '../models/ApiAnalytics';
import { Company } from '../models/Company';
import { CompanyUsageMetrics } from '../models/CompanyUsageMetrics';
import { ErrorAnalytics } from '../models/ErrorAnalytics';
import { SystemMetrics } from '../models/SystemMetrics';

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseRangeToHours(rangeRaw: unknown): number {
  const normalized = String(rangeRaw || '').toLowerCase();
  if (normalized === '1h') return 1;
  if (normalized === '6h') return 6;
  if (normalized === '12h') return 12;
  if (normalized === '24h') return 24;
  if (normalized === '7d') return 24 * 7;
  if (normalized === '30d') return 24 * 30;
  if (normalized === '90d') return 24 * 90;
  return 24;
}

function getRangeWindow(rangeRaw: unknown): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  const hours = parseRangeToHours(rangeRaw);
  const startDate = new Date(endDate.getTime() - hours * 60 * 60 * 1000);
  return { startDate, endDate };
}

function toObjectIdOrNull(value: unknown): mongoose.Types.ObjectId | null {
  if (!value) return null;
  const id = String(value);
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

export class SuperAdminAnalyticsController {
  static getSystemAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { startDate } = getRangeWindow(req.query.range);
    const limit = Math.min(parsePositiveInt(req.query.limit, 288), 2000);

    const series = await SystemMetrics.find({
      bucketStart: { $gte: startDate },
    })
      .sort({ bucketStart: 1 })
      .limit(limit)
      .lean();

    const summary = series.reduce(
      (acc, row) => {
        acc.apiRequests += row.apiRequests || 0;
        acc.errorRequests += row.errorRequests || 0;
        acc.avgResponseTimeWeighted += (row.avgResponseTime || 0) * (row.apiRequests || 0);
        acc.totalForAvg += row.apiRequests || 0;
        acc.p95ResponseTime = Math.max(acc.p95ResponseTime, row.p95ResponseTime || 0);
        acc.latestOcrQueueDepth = row.ocrQueueDepth ?? acc.latestOcrQueueDepth;
        acc.dbConnected = row.dbConnected ?? acc.dbConnected;
        acc.redisConnected = row.redisConnected ?? acc.redisConnected;
        return acc;
      },
      {
        apiRequests: 0,
        errorRequests: 0,
        avgResponseTimeWeighted: 0,
        totalForAvg: 0,
        p95ResponseTime: 0,
        latestOcrQueueDepth: 0,
        dbConnected: false,
        redisConnected: false,
      }
    );

    const avgResponseTime =
      summary.totalForAvg > 0
        ? Math.round((summary.avgResponseTimeWeighted / summary.totalForAvg) * 100) / 100
        : 0;

    res.status(200).json({
      success: true,
      data: {
        summary: {
          apiRequests: summary.apiRequests,
          errorRequests: summary.errorRequests,
          errorRate: summary.apiRequests > 0 ? Math.round((summary.errorRequests / summary.apiRequests) * 10000) / 100 : 0,
          avgResponseTime,
          p95ResponseTime: summary.p95ResponseTime,
          latestOcrQueueDepth: summary.latestOcrQueueDepth,
          dbConnected: summary.dbConnected,
          redisConnected: summary.redisConnected,
        },
        series: series.map((row) => ({
          bucketStart: row.bucketStart,
          bucketEnd: row.bucketEnd,
          apiRequests: row.apiRequests || 0,
          errorRequests: row.errorRequests || 0,
          avgResponseTime: row.avgResponseTime || 0,
          p95ResponseTime: row.p95ResponseTime || 0,
          ocrQueueDepth: row.ocrQueueDepth || 0,
          dbConnected: row.dbConnected,
          redisConnected: row.redisConnected,
        })),
      },
    });
  });

  static getApiAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { startDate } = getRangeWindow(req.query.range);
    const limit = Math.min(parsePositiveInt(req.query.limit, 100), 500);
    const companyId = toObjectIdOrNull(req.query.companyId);

    const match: Record<string, any> = {
      bucketStart: { $gte: startDate },
    };
    if (companyId) {
      match.companyId = companyId;
    }

    const grouped = await ApiAnalytics.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            method: '$method',
            path: '$path',
          },
          requestCount: { $sum: '$requestCount' },
          errorCount: { $sum: '$errorCount' },
          weightedAvgResponseTime: {
            $sum: {
              $multiply: ['$avgResponseTime', '$requestCount'],
            },
          },
          totalWeight: { $sum: '$requestCount' },
          maxP95: { $max: '$p95ResponseTime' },
        },
      },
      {
        $project: {
          _id: 0,
          method: '$_id.method',
          path: '$_id.path',
          requestCount: 1,
          errorCount: 1,
          avgResponseTime: {
            $cond: [
              { $gt: ['$totalWeight', 0] },
              { $divide: ['$weightedAvgResponseTime', '$totalWeight'] },
              0,
            ],
          },
          p95ResponseTime: '$maxP95',
        },
      },
      { $sort: { requestCount: -1 } },
      { $limit: limit },
    ]).exec();

    const totals = grouped.reduce(
      (acc, row) => {
        acc.requestCount += row.requestCount || 0;
        acc.errorCount += row.errorCount || 0;
        return acc;
      },
      { requestCount: 0, errorCount: 0 }
    );

    res.status(200).json({
      success: true,
      data: {
        totals: {
          requestCount: totals.requestCount,
          errorCount: totals.errorCount,
          errorRate: totals.requestCount > 0 ? Math.round((totals.errorCount / totals.requestCount) * 10000) / 100 : 0,
        },
        endpoints: grouped.map((row) => ({
          method: row.method,
          path: row.path,
          requestCount: row.requestCount || 0,
          errorCount: row.errorCount || 0,
          errorRate: row.requestCount > 0 ? Math.round(((row.errorCount || 0) / row.requestCount) * 10000) / 100 : 0,
          avgResponseTime: Math.round((row.avgResponseTime || 0) * 100) / 100,
          p95ResponseTime: row.p95ResponseTime || 0,
        })),
      },
    });
  });

  static getErrorAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { startDate } = getRangeWindow(req.query.range);
    const limit = Math.min(parsePositiveInt(req.query.limit, 100), 500);
    const companyId = toObjectIdOrNull(req.query.companyId);

    const match: Record<string, any> = {
      bucketStart: { $gte: startDate },
    };
    if (companyId) {
      match.companyId = companyId;
    }

    const grouped = await ErrorAnalytics.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            path: '$path',
            statusCode: '$statusCode',
          },
          errorCount: { $sum: '$errorCount' },
        },
      },
      {
        $project: {
          _id: 0,
          path: '$_id.path',
          statusCode: '$_id.statusCode',
          errorCount: 1,
        },
      },
      { $sort: { errorCount: -1 } },
      { $limit: limit },
    ]).exec();

    const totalErrors = grouped.reduce((sum, row) => sum + (row.errorCount || 0), 0);

    res.status(200).json({
      success: true,
      data: {
        totalErrors,
        errors: grouped,
      },
    });
  });

  static getCompanyAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { startDate } = getRangeWindow(req.query.range);
    const page = parsePositiveInt(req.query.page, 1);
    const pageSize = Math.min(parsePositiveInt(req.query.pageSize, 25), 100);
    const search = String(req.query.search || '').trim();

    const match: Record<string, any> = {
      bucketStart: { $gte: startDate },
    };

    const pipeline: any[] = [
      { $match: match },
      { $sort: { bucketStart: -1 } },
      {
        $group: {
          _id: '$companyId',
          latest: { $first: '$$ROOT' },
        },
      },
      {
        $lookup: {
          from: 'companies',
          localField: '_id',
          foreignField: '_id',
          as: 'company',
        },
      },
      {
        $addFields: {
          company: { $arrayElemAt: ['$company', 0] },
        },
      },
    ];

    if (search) {
      const regex = new RegExp(search, 'i');
      pipeline.push({
        $match: {
          $or: [{ 'company.name': regex }, { 'company.domain': regex }, { 'company.location': regex }],
        },
      });
    }

    const countResult = await CompanyUsageMetrics.aggregate([...pipeline, { $count: 'total' }]).exec();
    const total = countResult[0]?.total || 0;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;

    const rows = await CompanyUsageMetrics.aggregate([
      ...pipeline,
      { $sort: { 'latest.maxUsagePct': -1, 'latest.bucketStart': -1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      {
        $project: {
          _id: 0,
          companyId: '$_id',
          companyName: '$company.name',
          companyStatus: '$company.status',
          plan: '$company.plan',
          expensesUsed: '$latest.expensesUsed',
          reportsUsed: '$latest.reportsUsed',
          maxExpenses: '$latest.maxExpenses',
          maxReports: '$latest.maxReports',
          expenseUsagePct: '$latest.expenseUsagePct',
          reportUsagePct: '$latest.reportUsagePct',
          maxUsagePct: '$latest.maxUsagePct',
          bucketStart: '$latest.bucketStart',
          bucketEnd: '$latest.bucketEnd',
        },
      },
    ]).exec();

    const unresolvedCompanyIds = rows
      .filter((row) => !row.companyName && row.companyId)
      .map((row) => row.companyId);

    if (unresolvedCompanyIds.length > 0) {
      const companies = await Company.find({ _id: { $in: unresolvedCompanyIds } })
        .select('name status plan')
        .lean();
      const companyMap = new Map(companies.map((company) => [company._id.toString(), company]));
      rows.forEach((row) => {
        const key = row.companyId?.toString?.();
        if (!row.companyName && key && companyMap.has(key)) {
          const company = companyMap.get(key)!;
          row.companyName = company.name;
          row.companyStatus = company.status;
          row.plan = company.plan;
        }
      });
    }

    res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        status:
          row.maxUsagePct >= 100
            ? 'reached'
            : row.maxUsagePct >= 90
              ? 'critical'
              : row.maxUsagePct >= 70
                ? 'warning'
                : 'ok',
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  });
}


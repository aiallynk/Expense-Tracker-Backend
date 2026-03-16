import { Response } from 'express';
import mongoose from 'mongoose';

import { asyncHandler } from '../middleware/error.middleware';
import { Company } from '../models/Company';
import { AuthRequest } from '../middleware/auth.middleware';
import { CompanyLimitsService } from '../services/companyLimits.service';

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeStatusFilter(value?: string): string {
  return (value || '').trim().toLowerCase();
}

function buildCompanyLimitsBasePipeline(search?: string): any[] {
  const match: Record<string, any> = {};
  if (search && search.trim()) {
    const regex = new RegExp(search.trim(), 'i');
    match.$or = [{ name: regex }, { domain: regex }, { location: regex }];
  }

  const pipeline: any[] = [
    { $match: match },
    {
      $lookup: {
        from: 'companylimits',
        localField: '_id',
        foreignField: 'companyId',
        as: 'limitDoc',
      },
    },
    {
      $lookup: {
        from: 'companyusages',
        localField: '_id',
        foreignField: 'companyId',
        as: 'usageDoc',
      },
    },
    {
      $lookup: {
        from: 'companyadmins',
        let: { companyId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$companyId', '$$companyId'] },
            },
          },
          { $sort: { createdAt: 1 } },
          { $limit: 1 },
          { $project: { name: 1, email: 1 } },
        ],
        as: 'primaryAdmin',
      },
    },
    {
      $addFields: {
        limitDoc: {
          $ifNull: [
            { $arrayElemAt: ['$limitDoc', 0] },
            { maxExpenses: 0, maxReports: 0, limitsEnabled: false },
          ],
        },
        usageDoc: {
          $ifNull: [
            { $arrayElemAt: ['$usageDoc', 0] },
            { expensesUsed: 0, reportsUsed: 0, lastUpdated: null },
          ],
        },
        primaryAdmin: { $arrayElemAt: ['$primaryAdmin', 0] },
      },
    },
    {
      $addFields: {
        limitsEnabled: { $ifNull: ['$limitDoc.limitsEnabled', false] },
        maxExpenses: { $ifNull: ['$limitDoc.maxExpenses', 0] },
        maxReports: { $ifNull: ['$limitDoc.maxReports', 0] },
        expensesUsed: { $ifNull: ['$usageDoc.expensesUsed', 0] },
        reportsUsed: { $ifNull: ['$usageDoc.reportsUsed', 0] },
        lastUpdated: '$usageDoc.lastUpdated',
      },
    },
    {
      $addFields: {
        expenseUsagePct: {
          $cond: [
            { $gt: ['$maxExpenses', 0] },
            { $multiply: [{ $divide: ['$expensesUsed', '$maxExpenses'] }, 100] },
            0,
          ],
        },
        reportUsagePct: {
          $cond: [
            { $gt: ['$maxReports', 0] },
            { $multiply: [{ $divide: ['$reportsUsed', '$maxReports'] }, 100] },
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        totalLimitedUsed: {
          $add: [
            { $cond: [{ $gt: ['$maxExpenses', 0] }, '$expensesUsed', 0] },
            { $cond: [{ $gt: ['$maxReports', 0] }, '$reportsUsed', 0] },
          ],
        },
        totalLimitedMax: {
          $add: [
            { $cond: [{ $gt: ['$maxExpenses', 0] }, '$maxExpenses', 0] },
            { $cond: [{ $gt: ['$maxReports', 0] }, '$maxReports', 0] },
          ],
        },
      },
    },
    {
      $addFields: {
        usagePct: {
          $cond: [
            { $gt: ['$totalLimitedMax', 0] },
            {
              $min: [
                100,
                { $multiply: [{ $divide: ['$totalLimitedUsed', '$totalLimitedMax'] }, 100] },
              ],
            },
            0,
          ],
        },
      },
    },
  ];

  return pipeline;
}

function buildStatusMatch(status: string): Record<string, any> | null {
  if (!status) return null;

  switch (status) {
    case 'enabled':
      return { limitsEnabled: true };
    case 'disabled':
      return { limitsEnabled: false };
    case 'warning':
      return { usagePct: { $gte: 70, $lt: 90 } };
    case 'critical':
      return { usagePct: { $gte: 90, $lt: 100 } };
    case 'reached':
      return { usagePct: { $gte: 100 } };
    case 'active':
    case 'trial':
    case 'suspended':
    case 'inactive':
      return { status };
    default:
      return null;
  }
}

export class CompanyLimitsController {
  static listCompanyLimits = asyncHandler(async (req: AuthRequest, res: Response) => {
    const page = parsePositiveInt(req.query.page, 1);
    const pageSize = Math.min(parsePositiveInt(req.query.pageSize, 25), 100);
    const search = (req.query.search as string) || '';
    const status = normalizeStatusFilter(req.query.status as string | undefined);
    const sortBy = ((req.query.sortBy as string) || 'usage').toLowerCase();

    const basePipeline = buildCompanyLimitsBasePipeline(search);
    const statusMatch = buildStatusMatch(status);
    if (statusMatch) {
      basePipeline.push({ $match: statusMatch });
    }

    const countPipeline = [...basePipeline, { $count: 'total' }];
    const countResult = await Company.aggregate(countPipeline).exec();
    const total = countResult[0]?.total || 0;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;

    const sortStage =
      sortBy === 'name'
        ? { name: 1 as const }
        : sortBy === 'newest'
          ? { createdAt: -1 as const }
          : { usagePct: -1 as const, createdAt: -1 as const };

    const dataPipeline = [
      ...basePipeline,
      { $sort: sortStage },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      {
        $project: {
          _id: 0,
          companyId: '$_id',
          name: 1,
          location: 1,
          domain: 1,
          companyStatus: '$status',
          plan: 1,
          adminName: '$primaryAdmin.name',
          adminEmail: '$primaryAdmin.email',
          limitsEnabled: 1,
          maxExpenses: 1,
          maxReports: 1,
          expensesUsed: 1,
          reportsUsed: 1,
          expenseUsagePct: { $round: ['$expenseUsagePct', 2] },
          reportUsagePct: { $round: ['$reportUsagePct', 2] },
          usagePct: { $round: ['$usagePct', 2] },
          status: {
            $switch: {
              branches: [
                { case: { $gte: ['$usagePct', 100] }, then: 'reached' },
                { case: { $gte: ['$usagePct', 90] }, then: 'critical' },
                { case: { $gte: ['$usagePct', 70] }, then: 'warning' },
              ],
              default: 'ok',
            },
          },
          lastUpdated: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ];

    let rows = await Company.aggregate(dataPipeline).exec();

    const candidatesForUsageRepair = rows.filter(
      (row: any) =>
        row?.limitsEnabled === true &&
        ((Number(row?.maxExpenses) || 0) > 0 || (Number(row?.maxReports) || 0) > 0) &&
        (Number(row?.expensesUsed) || 0) === 0 &&
        (Number(row?.reportsUsed) || 0) === 0
    );

    if (candidatesForUsageRepair.length > 0) {
      const repairedUsage = await Promise.all(
        candidatesForUsageRepair.map(async (row: any) => {
          const payload = await CompanyLimitsService.getCompanyUsageSummary(String(row.companyId));
          return {
            companyId: String(row.companyId),
            payload,
          };
        })
      );

      const usageMap = new Map(repairedUsage.map((entry) => [entry.companyId, entry.payload]));
      rows = rows.map((row: any) => {
        const usage = usageMap.get(String(row.companyId));
        if (!usage) return row;

        return {
          ...row,
          expensesUsed: usage.expensesUsed,
          reportsUsed: usage.reportsUsed,
          expenseUsagePct: usage.expenseUsagePct,
          reportUsagePct: usage.reportUsagePct,
          usagePct: usage.usagePct,
          status: usage.status,
          lastUpdated: usage.lastUpdated,
        };
      });
    }

    res.status(200).json({
      success: true,
      data: rows,
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

  static getCompanyLimitsByCompanyId = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] : req.params.companyId;
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid company ID format',
      });
      return;
    }

    const company = await Company.findById(companyId).select('name status plan').lean();
    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found',
      });
      return;
    }

    const usage = await CompanyLimitsService.getCompanyUsageSummary(companyId);

    res.status(200).json({
      success: true,
      data: {
        companyName: company.name,
        companyStatus: company.status,
        plan: company.plan,
        ...usage,
      },
    });
  });

  static patchCompanyLimits = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] : req.params.companyId;
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid company ID format',
      });
      return;
    }

    const payload = await CompanyLimitsService.updateLimits(companyId, {
      maxExpenses: req.body.maxExpenses,
      maxReports: req.body.maxReports,
      limitsEnabled: req.body.limitsEnabled,
    });

    res.status(200).json({
      success: true,
      data: payload,
      message: 'Company limits updated successfully',
    });
  });

  static increaseCompanyLimits = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = Array.isArray(req.params.companyId) ? req.params.companyId[0] : req.params.companyId;
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid company ID format',
      });
      return;
    }

    const payload = await CompanyLimitsService.increaseLimits(companyId, {
      maxExpensesDelta: req.body.maxExpensesDelta ?? req.body.expensesDelta,
      maxReportsDelta: req.body.maxReportsDelta ?? req.body.reportsDelta,
    });

    res.status(200).json({
      success: true,
      data: payload,
      message: 'Company limits increased successfully',
    });
  });

  static getCompanyAdminUsageLimits = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await CompanyLimitsService.resolveCompanyIdForActor({
      userId: req.user!.id,
      role: req.user!.role,
      companyIdFromToken: req.user!.companyId,
    });

    if (!companyId) {
      res.status(404).json({
        success: false,
        message: 'Company context not found',
      });
      return;
    }

    const payload = await CompanyLimitsService.getCompanyUsageSummary(companyId);
    res.status(200).json({
      success: true,
      data: payload,
    });
  });
}

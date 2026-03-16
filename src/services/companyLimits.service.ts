import mongoose from 'mongoose';

import { logger } from '@/config/logger';

import { CompanyAdmin } from '../models/CompanyAdmin';
import { CompanyLimits, ICompanyLimits } from '../models/CompanyLimits';
import { CompanyUsage, ICompanyUsage } from '../models/CompanyUsage';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { NotificationType } from '../models/Notification';
import { User } from '../models/User';
import { emitCompanyLimitWarning, emitCompanyLimitsUpdated } from '../socket/realtimeEvents';
import { UserRole } from '../utils/enums';

import { NotificationDataService } from './notificationData.service';
import { SettingsService } from './settings.service';

type QuotaMetric = 'expenses' | 'reports';

const EXPENSE_LIMIT_MESSAGE = 'Company expense creation limit reached. Contact administrator.';
const REPORT_LIMIT_MESSAGE = 'Report generation limit reached.';
const WARNING_THRESHOLDS = [70, 90, 100] as const;

export interface CompanyLimitsUsagePayload {
  companyId: string;
  limitsEnabled: boolean;
  maxExpenses: number;
  maxReports: number;
  expensesUsed: number;
  reportsUsed: number;
  expenseUsagePct: number;
  reportUsagePct: number;
  usagePct: number;
  status: 'ok' | 'warning' | 'critical' | 'reached';
  lastUpdated: Date;
}

interface CompanyWarningPayload extends CompanyLimitsUsagePayload {
  metric: QuotaMetric;
  threshold: number;
}

function clampNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function usagePercent(used: number, max: number): number {
  if (!max || max <= 0) return 0;
  const pct = (used / max) * 100;
  return Math.max(0, Math.round(pct * 100) / 100);
}

function combinedUsagePercent(params: {
  expensesUsed: number;
  reportsUsed: number;
  maxExpenses: number;
  maxReports: number;
}): number {
  const {
    expensesUsed,
    reportsUsed,
    maxExpenses,
    maxReports,
  } = params;

  const expenseLimited = maxExpenses > 0;
  const reportLimited = maxReports > 0;
  const totalMax =
    (expenseLimited ? maxExpenses : 0) +
    (reportLimited ? maxReports : 0);

  if (totalMax <= 0) return 0;

  const totalUsed =
    (expenseLimited ? expensesUsed : 0) +
    (reportLimited ? reportsUsed : 0);
  const pct = usagePercent(totalUsed, totalMax);
  return Math.min(100, pct);
}

function usageStatus(maxUsagePct: number): CompanyLimitsUsagePayload['status'] {
  if (maxUsagePct >= 100) return 'reached';
  if (maxUsagePct >= 90) return 'critical';
  if (maxUsagePct >= 70) return 'warning';
  return 'ok';
}

function toObjectId(id: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(id);
}

export class CompanyLimitsService {
  private static async computeHistoricalUsageCounts(
    companyObjectId: mongoose.Types.ObjectId
  ): Promise<{ expensesUsed: number; reportsUsed: number }> {
    const userIds = await User.find({ companyId: companyObjectId }).distinct('_id');
    if (!userIds.length) {
      return { expensesUsed: 0, reportsUsed: 0 };
    }

    const [expensesUsed, reportsUsed] = await Promise.all([
      Expense.countDocuments({ userId: { $in: userIds } }),
      ExpenseReport.countDocuments({ userId: { $in: userIds } }),
    ]);

    return { expensesUsed, reportsUsed };
  }

  static async reconcileCompanyUsage(companyId: string): Promise<ICompanyUsage> {
    const companyObjectId = toObjectId(companyId);
    const usage = await this.getOrCreateUsage(companyId);
    const historical = await this.computeHistoricalUsageCounts(companyObjectId);

    const nextExpensesUsed = Math.max(usage.expensesUsed || 0, historical.expensesUsed || 0);
    const nextReportsUsed = Math.max(usage.reportsUsed || 0, historical.reportsUsed || 0);
    const needsUpdate =
      nextExpensesUsed !== (usage.expensesUsed || 0) || nextReportsUsed !== (usage.reportsUsed || 0);

    if (!needsUpdate) {
      return usage;
    }

    const updated = await CompanyUsage.findOneAndUpdate(
      { companyId: companyObjectId },
      {
        $set: {
          expensesUsed: nextExpensesUsed,
          reportsUsed: nextReportsUsed,
          lastUpdated: new Date(),
        },
      },
      { new: true }
    ).exec();

    return updated || usage;
  }

  static async isEnforcementEnabled(): Promise<boolean> {
    const settings = await SettingsService.getSettings();
    return settings.features?.companyLimitsEnforcementEnabled === true;
  }

  static async resolveCompanyIdForActor(params: {
    userId: string;
    role: string;
    explicitCompanyId?: string;
    companyIdFromToken?: string;
  }): Promise<string | null> {
    const { userId, role, explicitCompanyId, companyIdFromToken } = params;

    if (explicitCompanyId && mongoose.Types.ObjectId.isValid(explicitCompanyId)) {
      return explicitCompanyId;
    }

    if (companyIdFromToken && mongoose.Types.ObjectId.isValid(companyIdFromToken)) {
      return companyIdFromToken;
    }

    if (role === UserRole.COMPANY_ADMIN) {
      const companyAdmin = await CompanyAdmin.findById(userId).select('companyId').lean();
      return companyAdmin?.companyId ? companyAdmin.companyId.toString() : null;
    }

    if (role === 'SERVICE_ACCOUNT' && companyIdFromToken) {
      return companyIdFromToken;
    }

    const user = await User.findById(userId).select('companyId').lean();
    return user?.companyId ? user.companyId.toString() : null;
  }

  static async getOrCreateLimits(companyId: string): Promise<ICompanyLimits> {
    const companyObjectId = toObjectId(companyId);
    const limits = await CompanyLimits.findOneAndUpdate(
      { companyId: companyObjectId },
      {
        $setOnInsert: {
          companyId: companyObjectId,
          maxExpenses: 0,
          maxReports: 0,
          limitsEnabled: false,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).exec();

    if (!limits) {
      throw new Error('Failed to initialize company limits');
    }
    return limits;
  }

  static async getOrCreateUsage(companyId: string): Promise<ICompanyUsage> {
    const companyObjectId = toObjectId(companyId);
    const usage = await CompanyUsage.findOneAndUpdate(
      { companyId: companyObjectId },
      {
        $setOnInsert: {
          companyId: companyObjectId,
          expensesUsed: 0,
          reportsUsed: 0,
          lastUpdated: new Date(),
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).exec();

    if (!usage) {
      throw new Error('Failed to initialize company usage');
    }
    return usage;
  }

  static buildUsagePayload(
    companyId: string,
    limits: Pick<ICompanyLimits, 'limitsEnabled' | 'maxExpenses' | 'maxReports'>,
    usage: Pick<ICompanyUsage, 'expensesUsed' | 'reportsUsed' | 'lastUpdated'>
  ): CompanyLimitsUsagePayload {
    const maxExpenses = clampNumber(limits.maxExpenses);
    const maxReports = clampNumber(limits.maxReports);
    const expensesUsed = clampNumber(usage.expensesUsed);
    const reportsUsed = clampNumber(usage.reportsUsed);
    const expenseUsagePct = usagePercent(expensesUsed, maxExpenses);
    const reportUsagePct = usagePercent(reportsUsed, maxReports);
    const usagePct = combinedUsagePercent({
      expensesUsed,
      reportsUsed,
      maxExpenses,
      maxReports,
    });

    return {
      companyId,
      limitsEnabled: Boolean(limits.limitsEnabled),
      maxExpenses,
      maxReports,
      expensesUsed,
      reportsUsed,
      expenseUsagePct,
      reportUsagePct,
      usagePct,
      status: usageStatus(usagePct),
      lastUpdated: usage.lastUpdated || new Date(),
    };
  }

  static async getCompanyUsageSummary(companyId: string): Promise<CompanyLimitsUsagePayload> {
    const [limits, usage] = await Promise.all([
      this.getOrCreateLimits(companyId),
      this.reconcileCompanyUsage(companyId),
    ]);
    return this.buildUsagePayload(companyId, limits, usage);
  }

  static async updateLimits(
    companyId: string,
    updates: {
      maxExpenses?: number;
      maxReports?: number;
      limitsEnabled?: boolean;
    }
  ): Promise<CompanyLimitsUsagePayload> {
    const companyObjectId = toObjectId(companyId);
    const setPayload: Record<string, any> = {};
    const setOnInsertPayload: Record<string, any> = {
      companyId: companyObjectId,
      maxExpenses: 0,
      maxReports: 0,
      limitsEnabled: false,
    };

    if (updates.maxExpenses !== undefined) {
      setPayload.maxExpenses = clampNumber(updates.maxExpenses);
      delete setOnInsertPayload.maxExpenses;
    }
    if (updates.maxReports !== undefined) {
      setPayload.maxReports = clampNumber(updates.maxReports);
      delete setOnInsertPayload.maxReports;
    }
    if (updates.limitsEnabled !== undefined) {
      setPayload.limitsEnabled = Boolean(updates.limitsEnabled);
      delete setOnInsertPayload.limitsEnabled;
    }

    const limits = await CompanyLimits.findOneAndUpdate(
      { companyId: companyObjectId },
      {
        $setOnInsert: setOnInsertPayload,
        ...(Object.keys(setPayload).length > 0 ? { $set: setPayload } : {}),
      },
      {
        new: true,
        upsert: true,
      }
    ).exec();

    if (!limits) {
      throw new Error('Unable to update company limits');
    }

    const usage = await this.reconcileCompanyUsage(companyId);
    const payload = this.buildUsagePayload(companyId, limits, usage);
    emitCompanyLimitsUpdated(payload);
    return payload;
  }

  static async increaseLimits(
    companyId: string,
    deltas: { maxExpensesDelta?: number; maxReportsDelta?: number }
  ): Promise<CompanyLimitsUsagePayload> {
    const expensesDelta = clampNumber(deltas.maxExpensesDelta);
    const reportsDelta = clampNumber(deltas.maxReportsDelta);
    if (expensesDelta <= 0 && reportsDelta <= 0) {
      throw new Error('At least one positive delta is required');
    }

    const companyObjectId = toObjectId(companyId);
    const incPayload: Record<string, number> = {};
    const setOnInsertPayload: Record<string, any> = {
      companyId: companyObjectId,
      maxExpenses: 0,
      maxReports: 0,
      limitsEnabled: false,
    };

    if (expensesDelta > 0) {
      incPayload.maxExpenses = expensesDelta;
      delete setOnInsertPayload.maxExpenses;
    }
    if (reportsDelta > 0) {
      incPayload.maxReports = reportsDelta;
      delete setOnInsertPayload.maxReports;
    }

    const limits = await CompanyLimits.findOneAndUpdate(
      { companyId: companyObjectId },
      {
        $setOnInsert: setOnInsertPayload,
        $inc: incPayload,
      },
      {
        new: true,
        upsert: true,
      }
    ).exec();

    if (!limits) {
      throw new Error('Unable to increase company limits');
    }

    const usage = await this.reconcileCompanyUsage(companyId);
    const payload = this.buildUsagePayload(companyId, limits, usage);
    emitCompanyLimitsUpdated(payload);
    return payload;
  }

  static async ensureExpenseCreationAllowed(companyId: string): Promise<void> {
    await this.ensureQuotaAllowed(companyId, 'expenses');
  }

  static async ensureReportGenerationAllowed(companyId: string): Promise<void> {
    await this.ensureQuotaAllowed(companyId, 'reports');
  }

  private static buildLimitReachedError(metric: QuotaMetric): Error {
    const error: any = new Error(metric === 'expenses' ? EXPENSE_LIMIT_MESSAGE : REPORT_LIMIT_MESSAGE);
    error.statusCode = 403;
    error.code = metric === 'expenses' ? 'COMPANY_EXPENSE_LIMIT_REACHED' : 'COMPANY_REPORT_LIMIT_REACHED';
    return error;
  }

  private static async hydrateUsageIfNeeded(
    companyId: string,
    metric: QuotaMetric,
    usage: ICompanyUsage
  ): Promise<ICompanyUsage> {
    const metricUsed = metric === 'expenses' ? usage.expensesUsed : usage.reportsUsed;
    if (clampNumber(metricUsed) > 0) {
      return usage;
    }
    return this.reconcileCompanyUsage(companyId);
  }

  private static async ensureQuotaAllowed(companyId: string, metric: QuotaMetric): Promise<void> {
    const limits = await this.getOrCreateLimits(companyId);
    if (!limits.limitsEnabled) return;

    const maxAllowed = metric === 'expenses' ? limits.maxExpenses : limits.maxReports;
    if (maxAllowed <= 0) return;

    const usage = await this.getOrCreateUsage(companyId);
    const hydratedUsage = await this.hydrateUsageIfNeeded(companyId, metric, usage);
    const used = metric === 'expenses' ? hydratedUsage.expensesUsed : hydratedUsage.reportsUsed;
    if (used >= maxAllowed) {
      throw this.buildLimitReachedError(metric);
    }
  }

  static async consumeExpenseQuota(companyId: string): Promise<CompanyLimitsUsagePayload> {
    return this.consumeQuota(companyId, 'expenses');
  }

  static async consumeReportQuota(companyId: string): Promise<CompanyLimitsUsagePayload> {
    return this.consumeQuota(companyId, 'reports');
  }

  private static async consumeQuota(companyId: string, metric: QuotaMetric): Promise<CompanyLimitsUsagePayload> {
    const companyObjectId = toObjectId(companyId);
    const now = new Date();

    const limits = await this.getOrCreateLimits(companyId);
    const maxAllowed = metric === 'expenses' ? limits.maxExpenses : limits.maxReports;
    const isLimited = limits.limitsEnabled && maxAllowed > 0;

    // Ensure usage document exists once before conditional increment.
    const usage = await this.getOrCreateUsage(companyId);
    if (isLimited) {
      await this.hydrateUsageIfNeeded(companyId, metric, usage);
    }

    const incrementUpdate =
      metric === 'expenses'
        ? { $inc: { expensesUsed: 1 }, $set: { lastUpdated: now } }
        : { $inc: { reportsUsed: 1 }, $set: { lastUpdated: now } };

    const matchQuery =
      metric === 'expenses'
        ? {
            companyId: companyObjectId,
            ...(isLimited ? { expensesUsed: { $lt: maxAllowed } } : {}),
          }
        : {
            companyId: companyObjectId,
            ...(isLimited ? { reportsUsed: { $lt: maxAllowed } } : {}),
          };

    const previousUsage = await CompanyUsage.findOneAndUpdate(matchQuery, incrementUpdate, {
      new: false,
    })
      .lean<ICompanyUsage>()
      .exec();

    if (!previousUsage) {
      throw this.buildLimitReachedError(metric);
    }

    const previousValue = metric === 'expenses' ? previousUsage.expensesUsed : previousUsage.reportsUsed;
    const nextValue = previousValue + 1;
    await this.handleThresholdWarnings(companyId, limits, metric, previousValue, nextValue);

    const latestUsage = await this.getOrCreateUsage(companyId);
    return this.buildUsagePayload(companyId, limits, latestUsage);
  }

  private static async handleThresholdWarnings(
    companyId: string,
    limits: Pick<ICompanyLimits, 'limitsEnabled' | 'maxExpenses' | 'maxReports'>,
    metric: QuotaMetric,
    beforeValue: number,
    afterValue: number
  ): Promise<void> {
    if (!limits.limitsEnabled) return;

    const maxAllowed = metric === 'expenses' ? limits.maxExpenses : limits.maxReports;
    if (!maxAllowed || maxAllowed <= 0) return;

    const beforePct = usagePercent(beforeValue, maxAllowed);
    const afterPct = usagePercent(afterValue, maxAllowed);

    const crossedThresholds = WARNING_THRESHOLDS.filter(
      (threshold) => beforePct < threshold && afterPct >= threshold
    );

    if (crossedThresholds.length === 0) return;

    const usage = await this.getOrCreateUsage(companyId);
    const payloadBase = this.buildUsagePayload(companyId, limits, usage);

    for (const threshold of crossedThresholds) {
      const warningPayload: CompanyWarningPayload = {
        ...payloadBase,
        metric,
        threshold,
      };
      await this.dispatchThresholdWarning(warningPayload);
    }
  }

  private static async dispatchThresholdWarning(payload: CompanyWarningPayload): Promise<void> {
    const {
      companyId,
      metric,
      threshold,
      usagePct,
      expenseUsagePct,
      reportUsagePct,
      expensesUsed,
      reportsUsed,
      maxExpenses,
      maxReports,
    } = payload;

    const title = `Company ${metric} usage at ${threshold}%`;
    const description = `Usage is ${usagePct}% (expenses ${expenseUsagePct}% / reports ${reportUsagePct}%).`;
    const notificationKey = `company-limit-warning:${companyId}:${metric}:${threshold}`;

    try {
      await NotificationDataService.createNotification({
        companyId,
        type: NotificationType.BROADCAST,
        title,
        description,
        link: '/company-admin',
        metadata: {
          type: 'COMPANY_LIMIT_WARNING',
          companyId,
          metric,
          threshold,
          usagePct,
          expenseUsagePct,
          reportUsagePct,
          expensesUsed,
          reportsUsed,
          maxExpenses,
          maxReports,
        },
        notificationKey,
      });
    } catch (error) {
      logger.error({ error, companyId, metric, threshold }, 'Failed to create company limit warning notification');
    }

    emitCompanyLimitWarning({
      companyId,
      metric,
      threshold,
      usagePct,
      expenseUsagePct,
      reportUsagePct,
      expensesUsed,
      reportsUsed,
      maxExpenses,
      maxReports,
    });
  }
}

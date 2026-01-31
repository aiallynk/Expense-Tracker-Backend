import mongoose from 'mongoose';

import { CompanyAnalyticsSnapshot, ICompanyAnalyticsSnapshot } from '../models/CompanyAnalyticsSnapshot';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { ExpenseReportStatus, ExpenseStatus } from '../utils/enums';
import { analyticsQueue, AnalyticsQueueJob } from '../utils/analyticsQueue';
import { emitCompanyAdminDashboardUpdate } from '../socket/realtimeEvents';

import { logger } from '@/config/logger';

const PERIOD_MONTH = 'month';
const PERIOD_ALL = 'all';
const PERIOD_KEY_ALL = 'all';

function getCurrentMonthKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Get period keys to update for a report (based on approvedAt date and all-time).
 */
function getPeriodKeysForReport(approvedAt: Date): { period: string; periodKey: string }[] {
  const monthKey =
    `${approvedAt.getFullYear()}-${String(approvedAt.getMonth() + 1).padStart(2, '0')}`;
  return [
    { period: PERIOD_MONTH, periodKey: monthKey },
    { period: PERIOD_ALL, periodKey: PERIOD_KEY_ALL },
  ];
}

/**
 * Get or create a snapshot document for a company + period. Returns plain object for updates.
 */
async function getOrCreateSnapshot(
  companyId: string,
  period: string,
  periodKey: string
): Promise<ICompanyAnalyticsSnapshot> {
  const cid = new mongoose.Types.ObjectId(companyId);
  let doc = await CompanyAnalyticsSnapshot.findOne({
    companyId: cid,
    period,
    periodKey,
  }).exec();

  if (!doc) {
    doc = await CompanyAnalyticsSnapshot.create({
      companyId: cid,
      period,
      periodKey,
      totalReports: 0,
      approvedReports: 0,
      rejectedReports: 0,
      totalExpenseAmount: 0,
      approvedExpenseAmount: 0,
      rejectedExpenseAmount: 0,
      voucherUsedAmount: 0,
      employeePaidAmount: 0,
      categoryBreakdown: {},
    });
  }
  return doc;
}

/**
 * Validate snapshot invariants. Returns false if invalid.
 */
function validateSnapshot(doc: {
  totalExpenseAmount: number;
  approvedExpenseAmount: number;
  voucherUsedAmount: number;
}): boolean {
  if (doc.approvedExpenseAmount > doc.totalExpenseAmount) return false;
  if (doc.voucherUsedAmount > doc.approvedExpenseAmount) return false;
  return true;
}

/**
 * Convert snapshot to dashboard payload (current dashboard shape for backward compatibility).
 */
function snapshotToDashboardPayload(
  snapshot: ICompanyAnalyticsSnapshot | null,
  userCounts?: { totalUsers: number; employees: number; managers: number; businessHeads: number }
): any {
  if (!snapshot) {
    return {
      totalReports: 0,
      pendingApprovals: 0,
      totalSpendThisMonth: 0,
      totalAmountThisMonth: 0,
      totalAmount: 0,
      totalSpendsAllTime: 0,
      approvedReports: 0,
      rejectedReports: 0,
      totalExpenseAmount: 0,
      approvedExpenseAmount: 0,
      voucherUsedAmount: 0,
      employeePaidAmount: 0,
      categoryBreakdown: {},
      spendTrend: 0,
      ...userCounts,
    };
  }
  const doc = snapshot.toObject ? snapshot.toObject() : snapshot;
  return {
    totalReports: doc.totalReports ?? 0,
    pendingApprovals: 0,
    totalSpendThisMonth: doc.totalExpenseAmount ?? 0,
    totalAmountThisMonth: doc.totalExpenseAmount ?? 0,
    totalAmount: doc.totalExpenseAmount ?? 0,
    totalSpendsAllTime: 0, // Set by getDashboardPayload from all-time snapshot
    approvedReports: doc.approvedReports ?? 0,
    rejectedReports: doc.rejectedReports ?? 0,
    totalExpenseAmount: doc.totalExpenseAmount ?? 0,
    approvedExpenseAmount: doc.approvedExpenseAmount ?? 0,
    voucherUsedAmount: doc.voucherUsedAmount ?? 0,
    employeePaidAmount: doc.employeePaidAmount ?? 0,
    categoryBreakdown: doc.categoryBreakdown ?? {},
    spendTrend: 0,
    ...userCounts,
  };
}

/**
 * Enqueue an analytics event (non-blocking). Call from request path instead of inline aggregation.
 */
export function enqueueAnalyticsEvent(payload: {
  companyId: string;
  event: 'REPORT_SUBMITTED' | 'REPORT_APPROVED' | 'REPORT_REJECTED' | 'EXPENSE_ADDED' | 'VOUCHER_APPLIED' | 'SETTLEMENT_COMPLETED' | 'REBUILD_SNAPSHOT';
  reportId?: string;
  userId?: string;
  [key: string]: unknown;
}): void {
  analyticsQueue.enqueue(payload);
}

/**
 * Process a single analytics job (called by the worker).
 */
export async function processAnalyticsJob(job: AnalyticsQueueJob): Promise<void> {
  const { companyId, event, reportId } = job.payload;
  if (!companyId) {
    logger.warn({ jobId: job.id }, 'Analytics job missing companyId');
    return;
  }

  switch (event) {
    case 'REPORT_APPROVED':
      if (reportId) await handleReportApproved(companyId, reportId);
      break;
    case 'REPORT_REJECTED':
      if (reportId) await handleReportRejected(companyId, reportId);
      break;
    case 'REPORT_SUBMITTED':
      await handleReportSubmitted(companyId);
      break;
    case 'SETTLEMENT_COMPLETED':
      if (reportId) await handleSettlementCompleted(companyId, reportId);
      break;
    case 'EXPENSE_ADDED':
    case 'VOUCHER_APPLIED':
      // Impact already reflected when report is approved
      break;
    case 'REBUILD_SNAPSHOT':
      await rebuildSnapshotsForCompany(companyId);
      break;
    default:
      logger.warn({ event, jobId: job.id }, 'Unknown analytics event');
  }

  // After any event, emit current dashboard state for this company (current month snapshot)
  await emitSnapshotToDashboard(companyId);
}

async function emitSnapshotToDashboard(companyId: string): Promise<void> {
  try {
    const payload = await getDashboardPayload(companyId);
    emitCompanyAdminDashboardUpdate(companyId, payload);
  } catch (error) {
    logger.error({ error, companyId }, 'Failed to emit snapshot to dashboard');
  }
}

async function getUserCountsForCompany(companyId: string): Promise<{
  totalUsers: number;
  employees: number;
  managers: number;
  businessHeads: number;
}> {
  const users = await User.find({ companyId: new mongoose.Types.ObjectId(companyId), status: 'ACTIVE' })
    .select('role')
    .lean()
    .exec();
  return {
    totalUsers: users.length,
    employees: users.filter((u: any) => u.role === 'EMPLOYEE').length,
    managers: users.filter((u: any) => u.role === 'MANAGER').length,
    businessHeads: users.filter((u: any) => u.role === 'BUSINESS_HEAD').length,
  };
}

async function getCategoryBreakdownForReport(reportId: string): Promise<Record<string, number>> {
  const expenses = await Expense.find({
    reportId: new mongoose.Types.ObjectId(reportId),
    status: { $ne: ExpenseStatus.REJECTED },
  })
    .select('categoryId amount')
    .lean()
    .exec();
  const breakdown: Record<string, number> = {};
  for (const e of expenses) {
    const cid = e.categoryId ? (e.categoryId as mongoose.Types.ObjectId).toString() : '_none';
    breakdown[cid] = (breakdown[cid] || 0) + (e.amount || 0);
  }
  return breakdown;
}

async function handleReportApproved(companyId: string, reportId: string): Promise<void> {
  const report = await ExpenseReport.findById(reportId).lean().exec();
  if (!report || report.status !== ExpenseReportStatus.APPROVED) return;
  const approvedAt = report.approvedAt ? new Date(report.approvedAt) : new Date();
  const totalAmount = report.totalAmount ?? 0;
  const appliedVouchers = Array.isArray(report.appliedVouchers) ? report.appliedVouchers : [];
  const voucherUsed = appliedVouchers.reduce((s: number, v: any) => s + (v.amountUsed || 0), 0);
  const employeePaidAmountDelta = Math.max(0, totalAmount - voucherUsed);
  const categoryBreakdown = await getCategoryBreakdownForReport(reportId);

  const periodKeys = getPeriodKeysForReport(approvedAt);
  for (const { period, periodKey } of periodKeys) {
    const doc = await getOrCreateSnapshot(companyId, period, periodKey);
    doc.approvedReports = (doc.approvedReports || 0) + 1;
    doc.totalExpenseAmount = (doc.totalExpenseAmount || 0) + totalAmount;
    doc.approvedExpenseAmount = (doc.approvedExpenseAmount || 0) + totalAmount;
    doc.voucherUsedAmount = (doc.voucherUsedAmount || 0) + voucherUsed;
    doc.employeePaidAmount = (doc.employeePaidAmount || 0) + employeePaidAmountDelta;
    const cat = (doc.categoryBreakdown as Record<string, number>) || {};
    for (const [cid, amt] of Object.entries(categoryBreakdown)) {
      cat[cid] = (cat[cid] || 0) + amt;
    }
    doc.categoryBreakdown = cat;
    doc.updatedAt = new Date();
    if (!validateSnapshot(doc)) {
      logger.error({ companyId, periodKey }, 'Snapshot validation failed after REPORT_APPROVED');
      await rebuildSnapshotsForCompany(companyId);
      return;
    }
    await doc.save();
  }
}

async function handleReportRejected(companyId: string, reportId: string): Promise<void> {
  const report = await ExpenseReport.findById(reportId).lean().exec();
  if (!report) return;
  // If report was never approved, we only increment rejectedReports (no amount rollback).
  if (report.status !== ExpenseReportStatus.REJECTED) return;
  const rejectedAt = report.rejectedAt ? new Date(report.rejectedAt) : new Date();
  const periodKeys = getPeriodKeysForReport(rejectedAt);
  for (const { period, periodKey } of periodKeys) {
    const doc = await getOrCreateSnapshot(companyId, period, periodKey);
    doc.rejectedReports = Math.max(0, (doc.rejectedReports || 0) + 1);
    doc.updatedAt = new Date();
    await doc.save();
  }
}

async function handleReportSubmitted(companyId: string): Promise<void> {
  // Refresh report counts (totalReports, approvedReports, rejectedReports) so snapshot stays in sync.
  const cid = new mongoose.Types.ObjectId(companyId);
  const companyUsers = await User.find({ companyId: cid }).select('_id').lean().exec();
  const userIds = companyUsers.map((u: any) => u._id);
  if (userIds.length === 0) return;

  const [totalReports, approvedReports, rejectedReports] = await Promise.all([
    ExpenseReport.countDocuments({ userId: { $in: userIds } }),
    ExpenseReport.countDocuments({ userId: { $in: userIds }, status: ExpenseReportStatus.APPROVED }),
    ExpenseReport.countDocuments({ userId: { $in: userIds }, status: ExpenseReportStatus.REJECTED }),
  ]);

  const currentKey = getCurrentMonthKey();
  for (const { period, periodKey } of [
    { period: PERIOD_MONTH, periodKey: currentKey },
    { period: PERIOD_ALL, periodKey: PERIOD_KEY_ALL },
  ]) {
    const doc = await getOrCreateSnapshot(companyId, period, periodKey);
    doc.totalReports = totalReports;
    doc.approvedReports = approvedReports;
    doc.rejectedReports = rejectedReports;
    doc.updatedAt = new Date();
    await doc.save();
  }
}

async function handleSettlementCompleted(_companyId: string, _reportId: string): Promise<void> {
  // Amounts were already added when report was APPROVED. Settlement just confirms; no snapshot delta.
  // processAnalyticsJob will still emit dashboard update after this.
}

/**
 * Rebuild snapshot(s) for a company from APPROVED reports/expenses. Used for backfill and recovery.
 */
export async function rebuildSnapshotsForCompany(companyId: string): Promise<void> {
  const cid = new mongoose.Types.ObjectId(companyId);
  const companyUsers = await User.find({ companyId: cid }).select('_id').lean().exec();
  const userIds = companyUsers.map((u: any) => u._id);
  if (userIds.length === 0) {
    await ensureZeroSnapshots(companyId);
    return;
  }

  const reports = await ExpenseReport.find({
    userId: { $in: userIds },
    status: ExpenseReportStatus.APPROVED,
  })
    .select('totalAmount approvedAt appliedVouchers')
    .lean()
    .exec();

  const totalReports = await ExpenseReport.countDocuments({ userId: { $in: userIds } });
  const rejectedReports = await ExpenseReport.countDocuments({
    userId: { $in: userIds },
    status: ExpenseReportStatus.REJECTED,
  });
  const approvedCount = reports.length;

  let totalExpenseAmount = 0;
  let voucherUsedAmount = 0;
  const categoryBreakdownAll: Record<string, number> = {};
  const byMonth: Record<string, { amount: number; voucher: number; category: Record<string, number> }> = {};

  for (const r of reports) {
    const totalAmount = r.totalAmount ?? 0;
    const appliedVouchers = Array.isArray(r.appliedVouchers) ? r.appliedVouchers : [];
    const voucherUsed = appliedVouchers.reduce((s: number, v: any) => s + (v.amountUsed || 0), 0);
    totalExpenseAmount += totalAmount;
    voucherUsedAmount += voucherUsed;
    const reportId = (r as any)._id.toString();
    const cat = await getCategoryBreakdownForReport(reportId);
    for (const [cid, amt] of Object.entries(cat)) {
      categoryBreakdownAll[cid] = (categoryBreakdownAll[cid] || 0) + amt;
    }
    const approvedAt = r.approvedAt ? new Date(r.approvedAt) : new Date();
    const monthKey = `${approvedAt.getFullYear()}-${String(approvedAt.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[monthKey]) {
      byMonth[monthKey] = { amount: 0, voucher: 0, category: {} };
    }
    byMonth[monthKey].amount += totalAmount;
    byMonth[monthKey].voucher += voucherUsed;
    for (const [cid, amt] of Object.entries(cat)) {
      byMonth[monthKey].category[cid] = (byMonth[monthKey].category[cid] || 0) + amt;
    }
  }
  const employeePaidAmount = Math.max(0, totalExpenseAmount - voucherUsedAmount);

  // Upsert all-time snapshot
  await CompanyAnalyticsSnapshot.findOneAndUpdate(
    { companyId: cid, period: PERIOD_ALL, periodKey: PERIOD_KEY_ALL },
    {
      $set: {
        totalReports,
        approvedReports: approvedCount,
        rejectedReports,
        totalExpenseAmount,
        approvedExpenseAmount: totalExpenseAmount,
        voucherUsedAmount,
        employeePaidAmount,
        categoryBreakdown: categoryBreakdownAll,
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  ).exec();

  // Upsert current month snapshot
  const currentKey = getCurrentMonthKey();
  const currentMonth = byMonth[currentKey] || { amount: 0, voucher: 0, category: {} };
  await CompanyAnalyticsSnapshot.findOneAndUpdate(
    { companyId: cid, period: PERIOD_MONTH, periodKey: currentKey },
    {
      $set: {
        totalReports,
        approvedReports: approvedCount,
        rejectedReports,
        totalExpenseAmount: currentMonth.amount,
        approvedExpenseAmount: currentMonth.amount,
        voucherUsedAmount: currentMonth.voucher,
        employeePaidAmount: Math.max(0, currentMonth.amount - currentMonth.voucher),
        categoryBreakdown: currentMonth.category,
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  ).exec();
}

async function ensureZeroSnapshots(companyId: string): Promise<void> {
  const cid = new mongoose.Types.ObjectId(companyId);
  const currentKey = getCurrentMonthKey();
  const zero = {
    totalReports: 0,
    approvedReports: 0,
    rejectedReports: 0,
    totalExpenseAmount: 0,
    approvedExpenseAmount: 0,
    voucherUsedAmount: 0,
    employeePaidAmount: 0,
    categoryBreakdown: {},
    updatedAt: new Date(),
  };
  await CompanyAnalyticsSnapshot.findOneAndUpdate(
    { companyId: cid, period: PERIOD_ALL, periodKey: PERIOD_KEY_ALL },
    { $set: zero },
    { upsert: true }
  ).exec();
  await CompanyAnalyticsSnapshot.findOneAndUpdate(
    { companyId: cid, period: PERIOD_MONTH, periodKey: currentKey },
    { $set: zero },
    { upsert: true }
  ).exec();
}

/**
 * Get snapshot for dashboard (current month by default). Returns null if none.
 */
export async function getSnapshotForDashboard(
  companyId: string,
  periodKey?: string
): Promise<ICompanyAnalyticsSnapshot | null> {
  const key = periodKey || getCurrentMonthKey();
  const doc = await CompanyAnalyticsSnapshot.findOne({
    companyId: new mongoose.Types.ObjectId(companyId),
    period: PERIOD_MONTH,
    periodKey: key,
  }).exec();
  return doc;
}

/**
 * Get snapshot for a specific period (e.g. analytics page month selector).
 */
export async function getSnapshot(
  companyId: string,
  period: string,
  periodKey: string
): Promise<ICompanyAnalyticsSnapshot | null> {
  const doc = await CompanyAnalyticsSnapshot.findOne({
    companyId: new mongoose.Types.ObjectId(companyId),
    period,
    periodKey,
  }).exec();
  return doc;
}

/**
 * Get all-time snapshot for a company (for "Total Spends" / all months amount).
 */
export async function getSnapshotAllTime(companyId: string): Promise<ICompanyAnalyticsSnapshot | null> {
  return getSnapshot(companyId, PERIOD_ALL, PERIOD_KEY_ALL);
}

/**
 * Get dashboard payload for API (current month snapshot + all-time total + user counts).
 */
export async function getDashboardPayload(companyId: string, periodKey?: string): Promise<any> {
  const [snapshot, allTimeSnapshot, userCounts] = await Promise.all([
    getSnapshotForDashboard(companyId, periodKey),
    getSnapshotAllTime(companyId),
    getUserCountsForCompany(companyId),
  ]);
  const payload = snapshotToDashboardPayload(snapshot, userCounts);
  payload.totalSpendsAllTime = allTimeSnapshot?.totalExpenseAmount ?? allTimeSnapshot?.approvedExpenseAmount ?? 0;
  return payload;
}

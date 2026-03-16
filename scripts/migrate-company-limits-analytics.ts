import mongoose from 'mongoose';

import { connectDB, disconnectDB } from '../src/config/db';
import { ApiAnalytics } from '../src/models/ApiAnalytics';
import { ApiRequestLog } from '../src/models/ApiRequestLog';
import { Company } from '../src/models/Company';
import { CompanyLimits } from '../src/models/CompanyLimits';
import { CompanyUsage } from '../src/models/CompanyUsage';
import { CompanyUsageMetrics } from '../src/models/CompanyUsageMetrics';
import { ErrorAnalytics } from '../src/models/ErrorAnalytics';
import { Expense } from '../src/models/Expense';
import { ExpenseReport } from '../src/models/ExpenseReport';
import { SystemMetrics } from '../src/models/SystemMetrics';

function hasDryRunFlag(): boolean {
  return process.argv.includes('--dry-run') || process.argv.includes('-d');
}

async function ensureCollectionsAndIndexes(dryRun: boolean): Promise<void> {
  const models = [
    CompanyLimits,
    CompanyUsage,
    ApiAnalytics,
    ErrorAnalytics,
    SystemMetrics,
    CompanyUsageMetrics,
    ApiRequestLog,
  ];

  for (const model of models) {
    if (dryRun) {
      console.log(`[dry-run] Ensure collection + indexes: ${model.collection.collectionName}`);
      continue;
    }

    try {
      await model.createCollection();
    } catch (error: any) {
      // Ignore if collection already exists.
      if (error?.codeName !== 'NamespaceExists') {
        throw error;
      }
    }
    await model.createIndexes();
  }
}

async function computeCompanySeedCounts(): Promise<{
  expenseCountByCompany: Map<string, number>;
  reportCountByCompany: Map<string, number>;
}> {
  const [expenseRows, reportRows] = await Promise.all([
    Expense.aggregate([
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $group: {
          _id: '$user.companyId',
          count: { $sum: 1 },
        },
      },
    ]),
    ExpenseReport.aggregate([
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $group: {
          _id: '$user.companyId',
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const expenseCountByCompany = new Map<string, number>();
  const reportCountByCompany = new Map<string, number>();

  expenseRows.forEach((row) => {
    if (!row?._id) return;
    expenseCountByCompany.set(String(row._id), Number(row.count || 0));
  });

  reportRows.forEach((row) => {
    if (!row?._id) return;
    reportCountByCompany.set(String(row._id), Number(row.count || 0));
  });

  return { expenseCountByCompany, reportCountByCompany };
}

async function seedCompanyLimitsAndUsage(dryRun: boolean): Promise<void> {
  const companies = await Company.find({}).select('_id').lean();
  const { expenseCountByCompany, reportCountByCompany } = await computeCompanySeedCounts();

  console.log(`Found ${companies.length} companies to seed/verify.`);

  const now = new Date();
  let plannedUsageInserts = 0;
  let plannedLimitsInserts = 0;

  for (const company of companies) {
    const companyId = company._id as mongoose.Types.ObjectId;
    const key = companyId.toString();
    const expensesUsed = expenseCountByCompany.get(key) || 0;
    const reportsUsed = reportCountByCompany.get(key) || 0;

    const existingUsage = await CompanyUsage.exists({ companyId });
    const existingLimits = await CompanyLimits.exists({ companyId });

    if (!existingUsage) plannedUsageInserts += 1;
    if (!existingLimits) plannedLimitsInserts += 1;

    if (dryRun) {
      console.log(
        `[dry-run] company=${key} usageSeed={expensesUsed:${expensesUsed}, reportsUsed:${reportsUsed}} limitsDefault={maxExpenses:0,maxReports:0,limitsEnabled:false}`
      );
      continue;
    }

    await CompanyUsage.updateOne(
      { companyId },
      {
        $setOnInsert: {
          companyId,
          expensesUsed,
          reportsUsed,
          lastUpdated: now,
        },
      },
      { upsert: true }
    );

    await CompanyLimits.updateOne(
      { companyId },
      {
        $setOnInsert: {
          companyId,
          maxExpenses: 0,
          maxReports: 0,
          limitsEnabled: false,
        },
      },
      { upsert: true }
    );
  }

  console.log(
    dryRun
      ? `[dry-run] Planned inserts -> CompanyUsage: ${plannedUsageInserts}, CompanyLimits: ${plannedLimitsInserts}`
      : `Seed complete -> Inserted missing CompanyUsage/CompanyLimits docs as needed`
  );
}

async function run(): Promise<void> {
  const dryRun = hasDryRunFlag();
  console.log(`Starting company limits/analytics migration (dryRun=${dryRun})`);

  try {
    await connectDB();
    await ensureCollectionsAndIndexes(dryRun);
    await seedCompanyLimitsAndUsage(dryRun);
    console.log('Migration completed successfully.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await disconnectDB();
  }
}

void run();


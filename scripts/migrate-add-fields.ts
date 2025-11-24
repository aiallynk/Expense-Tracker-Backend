import mongoose from 'mongoose';
import { connectDB } from '../src/config/db';
import { User } from '../src/models/User';
import { Expense } from '../src/models/Expense';
import { ExpenseReport } from '../src/models/ExpenseReport';
import { Receipt } from '../src/models/Receipt';
import { OcrJob } from '../src/models/OcrJob';
import { AuditLog } from '../src/models/AuditLog';
import { NotificationToken } from '../src/models/NotificationToken';
import { logger } from '../src/utils/logger';

async function migrateDatabase() {
  try {
    console.log('Connecting to MongoDB...');
    await connectDB();
    console.log('Connected to MongoDB');

    const changes: string[] = [];

    // Migrate Users collection
    console.log('\n=== Migrating Users collection ===');
    const usersResult = await User.updateMany(
      { companyId: { $exists: false } },
      { $set: { companyId: null } }
    );
    if (usersResult.modifiedCount > 0) {
      changes.push(`Users: Added companyId field to ${usersResult.modifiedCount} documents`);
      console.log(`✓ Added companyId to ${usersResult.modifiedCount} users`);
    }

    const usersManagerResult = await User.updateMany(
      { managerId: { $exists: false } },
      { $set: { managerId: null } }
    );
    if (usersManagerResult.modifiedCount > 0) {
      changes.push(`Users: Added managerId field to ${usersManagerResult.modifiedCount} documents`);
      console.log(`✓ Added managerId to ${usersManagerResult.modifiedCount} users`);
    }

    const usersRolesResult = await User.updateMany(
      { roles: { $exists: false } },
      { $set: { roles: [] } }
    );
    if (usersRolesResult.modifiedCount > 0) {
      changes.push(`Users: Added roles array to ${usersRolesResult.modifiedCount} documents`);
      console.log(`✓ Added roles array to ${usersRolesResult.modifiedCount} users`);
    }

    // Migrate Expenses collection
    console.log('\n=== Migrating Expenses collection ===');
    const expensesUserIdResult = await Expense.updateMany(
      { userId: { $exists: false } },
      [
        {
          $set: {
            userId: { $ifNull: ['$reportId', null] },
          },
        },
      ]
    );
    if (expensesUserIdResult.modifiedCount > 0) {
      changes.push(`Expenses: Added userId field to ${expensesUserIdResult.modifiedCount} documents`);
      console.log(`✓ Added userId to ${expensesUserIdResult.modifiedCount} expenses`);
    }

    const expensesReceiptIdsResult = await Expense.updateMany(
      { receiptIds: { $exists: false } },
      { $set: { receiptIds: [] } }
    );
    if (expensesReceiptIdsResult.modifiedCount > 0) {
      changes.push(`Expenses: Added receiptIds array to ${expensesReceiptIdsResult.modifiedCount} documents`);
      console.log(`✓ Added receiptIds array to ${expensesReceiptIdsResult.modifiedCount} expenses`);
    }

    // Migrate existing receiptPrimaryId to receiptIds
    const expensesWithReceiptPrimary = await Expense.find({
      receiptPrimaryId: { $exists: true, $ne: null },
      receiptIds: { $size: 0 },
    });
    for (const expense of expensesWithReceiptPrimary) {
      if (expense.receiptPrimaryId) {
        await Expense.updateOne(
          { _id: expense._id },
          { $push: { receiptIds: expense.receiptPrimaryId } }
        );
      }
    }
    if (expensesWithReceiptPrimary.length > 0) {
      changes.push(`Expenses: Migrated receiptPrimaryId to receiptIds for ${expensesWithReceiptPrimary.length} documents`);
      console.log(`✓ Migrated receiptPrimaryId to receiptIds for ${expensesWithReceiptPrimary.length} expenses`);
    }

    // Migrate ExpenseReports collection
    console.log('\n=== Migrating ExpenseReports collection ===');
    const reportsApproversResult = await ExpenseReport.updateMany(
      { approvers: { $exists: false } },
      { $set: { approvers: [] } }
    );
    if (reportsApproversResult.modifiedCount > 0) {
      changes.push(`ExpenseReports: Added approvers array to ${reportsApproversResult.modifiedCount} documents`);
      console.log(`✓ Added approvers array to ${reportsApproversResult.modifiedCount} reports`);
    }

    // Migrate Receipts collection
    console.log('\n=== Migrating Receipts collection ===');
    const receiptsParsedDataResult = await Receipt.updateMany(
      { parsedData: { $exists: false } },
      { $set: { parsedData: null } }
    );
    if (receiptsParsedDataResult.modifiedCount > 0) {
      changes.push(`Receipts: Added parsedData field to ${receiptsParsedDataResult.modifiedCount} documents`);
      console.log(`✓ Added parsedData to ${receiptsParsedDataResult.modifiedCount} receipts`);
    }

    const receiptsUploadConfirmedResult = await Receipt.updateMany(
      { uploadConfirmed: { $exists: false } },
      { $set: { uploadConfirmed: true } } // Set to true for existing receipts
    );
    if (receiptsUploadConfirmedResult.modifiedCount > 0) {
      changes.push(`Receipts: Added uploadConfirmed field to ${receiptsUploadConfirmedResult.modifiedCount} documents`);
      console.log(`✓ Added uploadConfirmed to ${receiptsUploadConfirmedResult.modifiedCount} receipts`);
    }

    // Migrate OcrJobs collection
    console.log('\n=== Migrating OcrJobs collection ===');
    const ocrJobsAttemptsResult = await OcrJob.updateMany(
      { attempts: { $exists: false } },
      { $set: { attempts: 0 } }
    );
    if (ocrJobsAttemptsResult.modifiedCount > 0) {
      changes.push(`OcrJobs: Added attempts field to ${ocrJobsAttemptsResult.modifiedCount} documents`);
      console.log(`✓ Added attempts to ${ocrJobsAttemptsResult.modifiedCount} OCR jobs`);
    }

    // Migrate AuditLogs collection
    console.log('\n=== Migrating AuditLogs collection ===');
    const auditLogsMetaResult = await AuditLog.updateMany(
      { meta: { $exists: false } },
      { $set: { meta: null } }
    );
    if (auditLogsMetaResult.modifiedCount > 0) {
      changes.push(`AuditLogs: Added meta field to ${auditLogsMetaResult.modifiedCount} documents`);
      console.log(`✓ Added meta to ${auditLogsMetaResult.modifiedCount} audit logs`);
    }

    // Migrate NotificationTokens collection
    console.log('\n=== Migrating NotificationTokens collection ===');
    const notificationTokensTokenResult = await NotificationToken.updateMany(
      { token: { $exists: false }, fcmToken: { $exists: true } },
      [
        {
          $set: {
            token: '$fcmToken',
          },
        },
      ]
    );
    if (notificationTokensTokenResult.modifiedCount > 0) {
      changes.push(`NotificationTokens: Added token field (copied from fcmToken) to ${notificationTokensTokenResult.modifiedCount} documents`);
      console.log(`✓ Added token field to ${notificationTokensTokenResult.modifiedCount} notification tokens`);
    }

    // Summary
    console.log('\n=== Migration Summary ===');
    if (changes.length === 0) {
      console.log('✓ No migrations needed - all collections are up to date');
    } else {
      console.log(`✓ Migrated ${changes.length} field(s):`);
      changes.forEach((change) => console.log(`  - ${change}`));
    }

    console.log('\n✓ Migration completed successfully');
  } catch (error: any) {
    console.error('Migration failed:', error);
    logger.error('Migration error:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
    process.exit(0);
  }
}

// Run migration
migrateDatabase();


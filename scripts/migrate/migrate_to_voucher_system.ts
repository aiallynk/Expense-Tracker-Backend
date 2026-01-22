/**
 * Migration Script: Convert existing AdvanceCash to Voucher System
 * 
 * This script migrates existing advance cash entries to the new voucher system:
 * 1. Updates AdvanceCash documents to use new fields (totalAmount, remainingAmount, etc.)
 * 2. Creates VoucherUsage entries for existing report assignments
 * 3. Creates initial ledger entries
 * 
 * Run with: npx ts-node scripts/migrate/migrate_to_voucher_system.ts
 */

import mongoose from 'mongoose';
import { config } from '../../src/config';
import { AdvanceCash } from '../../src/models/AdvanceCash';
import { VoucherUsage, VoucherUsageStatus } from '../../src/models/VoucherUsage';
import { ExpenseReport } from '../../src/models/ExpenseReport';
import { Ledger, LedgerEntryType } from '../../src/models/Ledger';
import { getFinancialYear } from '../../src/utils/financialYear';

async function migrateToVoucherSystem() {
  try {
    // Connect to database
    await mongoose.connect(config.database.url);
    console.log('✅ Connected to database');

    // Get all advance cash entries
    const advanceCashEntries = await AdvanceCash.find({}).exec();
    console.log(`📊 Found ${advanceCashEntries.length} advance cash entries to migrate`);

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const advance of advanceCashEntries) {
      try {
        // Skip if already migrated (has totalAmount)
        if (advance.totalAmount !== undefined && advance.totalAmount > 0) {
          console.log(`⏭️  Skipping ${advance._id} - already migrated`);
          skipped++;
          continue;
        }

        // Migrate fields
        const oldAmount = advance.amount || 0;
        const oldBalance = advance.balance || 0;
        const oldUsedAmount = advance.usedAmount || 0;

        // Set new fields
        advance.totalAmount = oldAmount;
        advance.remainingAmount = oldBalance;
        advance.usedAmount = oldUsedAmount;

        // Calculate status
        if (advance.status === 'SETTLED' || oldBalance === 0) {
          advance.status = 'EXHAUSTED';
        } else if (oldBalance < oldAmount) {
          advance.status = 'PARTIAL';
        } else {
          advance.status = 'ACTIVE';
        }

        // Sync legacy fields for backward compatibility
        advance.amount = oldAmount;
        advance.balance = oldBalance;

        await advance.save();

        // Create VoucherUsage entry if voucher is assigned to a report
        if (advance.reportId) {
          const report = await ExpenseReport.findById(advance.reportId).exec();
          if (report) {
            // Check if VoucherUsage already exists
            const existingUsage = await VoucherUsage.findOne({
              voucherId: advance._id,
              reportId: advance.reportId,
            }).exec();

            if (!existingUsage) {
              const user = await mongoose.model('User').findById(advance.employeeId).select('companyId').exec();
              
              if (user && user.companyId) {
                const voucherUsage = new VoucherUsage({
                  voucherId: advance._id,
                  reportId: advance.reportId,
                  userId: advance.employeeId,
                  companyId: user.companyId,
                  amountUsed: oldUsedAmount || (oldAmount - oldBalance),
                  currency: advance.currency,
                  appliedAt: advance.createdAt,
                  appliedBy: advance.employeeId,
                  status: VoucherUsageStatus.APPLIED,
                });

                await voucherUsage.save();
                console.log(`✅ Created VoucherUsage for voucher ${advance._id} and report ${advance.reportId}`);
              }
            }
          }
        }

        // Create initial ledger entry for voucher issuance
        const existingLedger = await Ledger.findOne({
          voucherId: advance._id,
          entryType: LedgerEntryType.VOUCHER_ISSUED,
        }).exec();

        if (!existingLedger) {
          const user = await mongoose.model('User').findById(advance.employeeId).select('name email companyId').exec();
          const employeeName = (user as any)?.name || (user as any)?.email || 'Employee';

          if (user && user.companyId) {
            const { year: financialYear } = getFinancialYear(advance.createdAt);

            const ledgerEntry = new Ledger({
              companyId: user.companyId,
              entryType: LedgerEntryType.VOUCHER_ISSUED,
              voucherId: advance._id,
              userId: advance.employeeId,
              amount: oldAmount,
              currency: advance.currency,
              debitAccount: 'ADVANCE_CASH_PAID',
              creditAccount: 'EMPLOYEE_ADVANCE',
              description: `Voucher issued to ${employeeName}${advance.voucherCode ? ` (Code: ${advance.voucherCode})` : ''}`,
              referenceId: advance.voucherCode || advance._id.toString(),
              financialYear,
              entryDate: advance.createdAt,
              createdBy: advance.createdBy,
            });

            await ledgerEntry.save();
            console.log(`✅ Created ledger entry for voucher ${advance._id}`);
          }
        }

        migrated++;
        console.log(`✅ Migrated voucher ${advance._id}`);
      } catch (error: any) {
        console.error(`❌ Error migrating voucher ${advance._id}:`, error.message);
        errors++;
      }
    }

    console.log('\n📈 Migration Summary:');
    console.log(`   ✅ Migrated: ${migrated}`);
    console.log(`   ⏭️  Skipped: ${skipped}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`   📊 Total: ${advanceCashEntries.length}`);

    await mongoose.disconnect();
    console.log('✅ Disconnected from database');
  } catch (error: any) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
migrateToVoucherSystem();

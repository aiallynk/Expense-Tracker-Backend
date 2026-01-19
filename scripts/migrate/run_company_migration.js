require('dotenv').config();
const { validate } = require('./00_validate');
const { migrateCompany } = require('./01_company');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Migration order based on Prisma schema dependencies
 */
const MIGRATION_ORDER = [
  { step: 1, model: 'Company', dependencies: [] },
  { step: 2, model: 'User', dependencies: ['Company'] },
  { step: 3, model: 'Department', dependencies: ['Company', 'User'] },
  { step: 4, model: 'Role', dependencies: ['Company'] },
  { step: 5, model: 'CompanySettings', dependencies: ['Company'] },
  { step: 6, model: 'Category', dependencies: ['Company'] },
  { step: 7, model: 'CostCentre', dependencies: ['Company'] },
  { step: 8, model: 'Project', dependencies: ['Company', 'CostCentre', 'User'] },
  { step: 9, model: 'ExpenseReport', dependencies: ['User', 'Project'] },
  { step: 10, model: 'Expense', dependencies: ['User', 'ExpenseReport', 'Category', 'CostCentre', 'Project'] },
  { step: 11, model: 'Receipt', dependencies: ['Expense'] },
  { step: 12, model: 'OcrJob', dependencies: ['Receipt'] },
  { step: 13, model: 'AdvanceCash', dependencies: ['Company', 'User'] },
  { step: 14, model: 'AdvanceCashTransaction', dependencies: ['User', 'AdvanceCash', 'Expense'] },
];

/**
 * Generate migration report
 */
async function generateReport(validationResults, migrationStats) {
  console.log('\n\n');
  console.log('========================================');
  console.log('  MIGRATION REPORT');
  console.log('========================================\n');
  
  // 1. MongoDB Collections Found + Counts
  console.log('1. MONGODB COLLECTIONS FOUND:');
  console.log('   ' + '='.repeat(50));
  if (validationResults.mongo.success && validationResults.mongo.collections.length > 0) {
    validationResults.mongo.collections.forEach((col) => {
      console.log(`   - ${col.name}: ${col.count} document(s)`);
    });
  } else {
    console.log('   ❌ Failed to retrieve MongoDB collections');
  }
  
  // 2. PostgreSQL Tables Found + Counts
  console.log('\n2. POSTGRESQL TABLES FOUND:');
  console.log('   ' + '='.repeat(50));
  if (validationResults.postgres.success && validationResults.postgres.tables.length > 0) {
    validationResults.postgres.tables.forEach((table) => {
      console.log(`   - ${table.name}: ${table.count} row(s)`);
    });
  } else {
    console.log('   ❌ Failed to retrieve PostgreSQL tables');
  }
  
  // 3. Confirmed Migration Order
  console.log('\n3. CONFIRMED MIGRATION ORDER:');
  console.log('   ' + '='.repeat(50));
  MIGRATION_ORDER.forEach((item) => {
    const deps = item.dependencies.length > 0 
      ? ` (depends on: ${item.dependencies.join(', ')})` 
      : ' (no dependencies)';
    const status = item.step === 1 ? ' ✅ COMPLETED' : ' ⏳ PENDING';
    console.log(`   ${item.step}. ${item.model}${deps}${status}`);
  });
  
  // 4. Company Migration Result Summary
  console.log('\n4. COMPANY MIGRATION RESULT SUMMARY:');
  console.log('   ' + '='.repeat(50));
  if (migrationStats) {
    console.log(`   Total MongoDB records: ${migrationStats.total}`);
    console.log(`   Successfully inserted: ${migrationStats.inserted}`);
    console.log(`   Skipped (already exist): ${migrationStats.skipped}`);
    console.log(`   Errors: ${migrationStats.errors.length}`);
    
    if (migrationStats.errors.length > 0) {
      console.log('\n   Error Details:');
      migrationStats.errors.forEach((err, idx) => {
        console.log(`     ${idx + 1}. ${err}`);
      });
    }
  } else {
    console.log('   ❌ Migration not executed or failed');
  }
  
  // 5. Schema Mismatches or Potential Blockers
  console.log('\n5. SCHEMA MISMATCHES / POTENTIAL BLOCKERS:');
  console.log('   ' + '='.repeat(50));
  
  const blockers = [];
  
  // Check MongoDB connection
  if (!validationResults.mongo.success) {
    blockers.push(`MongoDB connection failed: ${validationResults.mongo.error}`);
  }
  
  // Check PostgreSQL connection
  if (!validationResults.postgres.success) {
    blockers.push(`PostgreSQL connection failed: ${validationResults.postgres.error}`);
  }
  
  // Check if companies collection exists
  const companiesCollection = validationResults.mongo.collections.find(
    (col) => col.name === 'companies'
  );
  if (!companiesCollection) {
    blockers.push('MongoDB "companies" collection not found');
  }
  
  // Check for enum mismatches (informational)
  console.log('   Schema Field Mapping:');
  console.log('     - MongoDB ObjectId → PostgreSQL UUID (deterministic conversion)');
  console.log('     - MongoDB status (lowercase) → PostgreSQL status (UPPERCASE enum)');
  console.log('     - MongoDB plan (lowercase) → PostgreSQL plan (UPPERCASE enum)');
  console.log('     - Optional MongoDB fields (shortcut, location, type, domain, logos) are skipped');
  
  if (blockers.length > 0) {
    console.log('\n   ⚠️  Potential Blockers:');
    blockers.forEach((blocker, idx) => {
      console.log(`     ${idx + 1}. ${blocker}`);
    });
  } else {
    console.log('\n   ✅ No blockers detected');
  }
  
  // 6. Next Step Recommendation
  console.log('\n6. NEXT STEP RECOMMENDATION:');
  console.log('   ' + '='.repeat(50));
  
  if (migrationStats && migrationStats.errors.length === 0 && migrationStats.inserted > 0) {
    console.log('   ✅ Company migration completed successfully!');
    console.log('   📋 Next step: Run User migration script');
    console.log('      File: scripts/migrate/02_user.js (to be created)');
    console.log('      Note: User migration depends on Company, so ensure Company migration is complete.');
  } else if (migrationStats && migrationStats.total === 0) {
    console.log('   ⚠️  No companies found in MongoDB to migrate.');
    console.log('   📋 Next step: Verify MongoDB data or proceed to User migration if companies are not needed.');
  } else if (migrationStats && migrationStats.errors.length > 0) {
    console.log('   ⚠️  Company migration completed with errors.');
    console.log('   📋 Next step: Review and fix errors before proceeding to User migration.');
  } else {
    console.log('   ❌ Company migration not completed.');
    console.log('   📋 Next step: Fix connection or data issues before retrying.');
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('  END OF REPORT');
  console.log('='.repeat(50) + '\n');
}

/**
 * Main execution function
 */
async function main() {
  console.log('========================================');
  console.log('  MongoDB → PostgreSQL Migration');
  console.log('  Company Migration Step');
  console.log('========================================\n');
  
  try {
    // Step 1: Validate connections
    console.log('STEP 1: Validating connections...\n');
    const validationResults = await validate();
    
    if (!validationResults.mongo.success || !validationResults.postgres.success) {
      console.error('\n❌ Validation failed. Cannot proceed with migration.');
      process.exit(1);
    }
    
    // Step 2: Display migration order
    console.log('\n\nSTEP 2: Migration Order');
    console.log('='.repeat(50));
    MIGRATION_ORDER.forEach((item) => {
      const deps = item.dependencies.length > 0 
        ? ` (depends on: ${item.dependencies.join(', ')})` 
        : ' (no dependencies)';
      const marker = item.step === 1 ? ' ← CURRENT STEP' : '';
      console.log(`${item.step}. ${item.model}${deps}${marker}`);
    });
    
    // Step 3: Run Company migration
    console.log('\n\nSTEP 3: Running Company migration...\n');
    const migrationStats = await migrateCompany();
    
    // Step 4: Generate report
    console.log('\n\nSTEP 4: Generating report...\n');
    await generateReport(validationResults, migrationStats);
    
    // Exit successfully
    if (migrationStats.errors.length === 0) {
      console.log('✅ Migration process completed successfully');
      process.exit(0);
    } else {
      console.log('⚠️  Migration completed with errors. Please review the report above.');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n❌ Migration process failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { main, generateReport, MIGRATION_ORDER };

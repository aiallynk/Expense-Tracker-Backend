require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { connectMongo, disconnectMongo, getDb } = require('../mongo/client');
const { validate } = require('./00_validate');
const utils = require('./utils');

const prisma = new PrismaClient();

// Migration order based on dependencies
const MIGRATION_ORDER = [
  { step: 1, model: 'Company', collection: 'companies', dependencies: [] },
  { step: 2, model: 'User', collection: 'users', dependencies: ['Company'] },
  { step: 3, model: 'Department', collection: 'departments', dependencies: ['Company', 'User'] },
  { step: 4, model: 'Role', collection: 'roles', dependencies: ['Company'] },
  { step: 5, model: 'CompanySettings', collection: 'companysettings', dependencies: ['Company'] },
  { step: 6, model: 'Category', collection: 'categories', dependencies: ['Company'] },
  { step: 7, model: 'CostCentre', collection: 'costcentres', dependencies: ['Company'] },
  { step: 8, model: 'Project', collection: 'projects', dependencies: ['Company', 'CostCentre', 'User'] },
  { step: 9, model: 'ExpenseReport', collection: 'expensereports', dependencies: ['User', 'Project'] },
  { step: 10, model: 'Expense', collection: 'expenses', dependencies: ['User', 'ExpenseReport', 'Category', 'CostCentre', 'Project'] },
  { step: 11, model: 'Receipt', collection: 'receipts', dependencies: ['Expense'] },
  { step: 12, model: 'OcrJob', collection: 'ocrjobs', dependencies: ['Receipt'] },
  { step: 13, model: 'AdvanceCash', collection: 'advancecashes', dependencies: ['Company', 'User'] },
  { step: 14, model: 'AdvanceCashTransaction', collection: 'advancecashtransactions', dependencies: ['User', 'AdvanceCash', 'Expense'] },
];

// Store migration results
const migrationResults = {};

/**
 * Migrate Company collection
 */
async function migrateCompany() {
  const db = getDb();
  const collection = db.collection('companies');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.company.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.company.create({
        data: {
          id: uuid,
          name: doc.name || 'Unnamed Company',
          status: utils.mapStatus(doc.status) || 'ACTIVE',
          plan: utils.mapPlan(doc.plan) || 'BASIC',
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`Company ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate User collection
 */
async function migrateUser() {
  const db = getDb();
  const collection = db.collection('users');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.user.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.user.create({
        data: {
          id: uuid,
          email: doc.email,
          passwordHash: doc.passwordHash,
          name: doc.name || null,
          phone: doc.phone || null,
          role: utils.mapUserRole(doc.role) || 'EMPLOYEE',
          status: utils.mapUserStatus(doc.status) || 'ACTIVE',
          companyId: doc.companyId ? utils.objectIdToUuid(doc.companyId) : null,
          managerId: doc.managerId ? utils.objectIdToUuid(doc.managerId) : null,
          departmentId: doc.departmentId ? utils.objectIdToUuid(doc.departmentId) : null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`User ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate Department collection
 */
async function migrateDepartment() {
  const db = getDb();
  const collection = db.collection('departments');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.department.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.department.create({
        data: {
          id: uuid,
          name: doc.name,
          status: utils.mapDepartmentStatus(doc.status) || 'ACTIVE',
          companyId: doc.companyId ? utils.objectIdToUuid(doc.companyId) : null,
          headId: doc.headId ? utils.objectIdToUuid(doc.headId) : null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`Department ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate Role collection
 */
async function migrateRole() {
  const db = getDb();
  const collection = db.collection('roles');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.role.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.role.create({
        data: {
          id: uuid,
          name: doc.name,
          type: utils.mapRoleType(doc.type) || 'CUSTOM',
          isActive: doc.isActive !== undefined ? doc.isActive : true,
          companyId: doc.companyId ? utils.objectIdToUuid(doc.companyId) : null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`Role ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate CompanySettings collection
 */
async function migrateCompanySettings() {
  const db = getDb();
  const collection = db.collection('companysettings');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.companySettings.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.companySettings.create({
        data: {
          id: uuid,
          companyId: doc.companyId ? utils.objectIdToUuid(doc.companyId) : null,
          timezone: doc.timezone || 'Asia/Kolkata',
          currency: doc.currency || 'INR',
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`CompanySettings ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate Category collection
 */
async function migrateCategory() {
  const db = getDb();
  const collection = db.collection('categories');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.category.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.category.create({
        data: {
          id: uuid,
          name: doc.name,
          status: utils.mapCategoryStatus(doc.status) || 'ACTIVE',
          isCustom: doc.isCustom !== undefined ? doc.isCustom : true,
          companyId: doc.companyId ? utils.objectIdToUuid(doc.companyId) : null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`Category ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate CostCentre collection
 */
async function migrateCostCentre() {
  const db = getDb();
  const collection = db.collection('costcentres');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.costCentre.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.costCentre.create({
        data: {
          id: uuid,
          name: doc.name,
          status: utils.mapCostCentreStatus(doc.status) || 'ACTIVE',
          budget: doc.budget || null,
          spentAmount: doc.spentAmount || 0,
          companyId: doc.companyId ? utils.objectIdToUuid(doc.companyId) : null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`CostCentre ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate Project collection
 */
async function migrateProject() {
  const db = getDb();
  const collection = db.collection('projects');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.project.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.project.create({
        data: {
          id: uuid,
          name: doc.name,
          status: utils.mapProjectStatus(doc.status) || 'ACTIVE',
          budget: doc.budget || null,
          spentAmount: doc.spentAmount || 0,
          companyId: doc.companyId ? utils.objectIdToUuid(doc.companyId) : null,
          costCentreId: doc.costCentreId ? utils.objectIdToUuid(doc.costCentreId) : null,
          managerId: doc.managerId ? utils.objectIdToUuid(doc.managerId) : null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`Project ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate ExpenseReport collection
 */
async function migrateExpenseReport() {
  const db = getDb();
  const collection = db.collection('expensereports');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.expenseReport.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.expenseReport.create({
        data: {
          id: uuid,
          name: doc.name,
          status: utils.mapExpenseReportStatus(doc.status) || 'DRAFT',
          fromDate: doc.fromDate || new Date(),
          toDate: doc.toDate || new Date(),
          totalAmount: doc.totalAmount || 0,
          currency: doc.currency || 'INR',
          userId: doc.userId ? utils.objectIdToUuid(doc.userId) : null,
          projectId: doc.projectId ? utils.objectIdToUuid(doc.projectId) : null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`ExpenseReport ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate Expense collection
 */
async function migrateExpense() {
  const db = getDb();
  const collection = db.collection('expenses');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.expense.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.expense.create({
        data: {
          id: uuid,
          vendor: doc.vendor || 'Unknown Vendor',
          amount: doc.amount || 0,
          currency: doc.currency || 'INR',
          expenseDate: doc.expenseDate || doc.createdAt || new Date(),
          status: utils.mapExpenseStatus(doc.status) || 'DRAFT',
          source: utils.mapExpenseSource(doc.source) || 'MANUAL',
          userId: doc.userId ? utils.objectIdToUuid(doc.userId) : null,
          reportId: doc.reportId ? utils.objectIdToUuid(doc.reportId) : null,
          categoryId: doc.categoryId ? utils.objectIdToUuid(doc.categoryId) : null,
          costCentreId: doc.costCentreId ? utils.objectIdToUuid(doc.costCentreId) : null,
          projectId: doc.projectId ? utils.objectIdToUuid(doc.projectId) : null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`Expense ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate Receipt collection
 */
async function migrateReceipt() {
  const db = getDb();
  const collection = db.collection('receipts');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.receipt.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.receipt.create({
        data: {
          id: uuid,
          expenseId: doc.expenseId ? utils.objectIdToUuid(doc.expenseId) : null,
          storageKey: doc.storageKey || doc.storageUrl || '',
          storageUrl: doc.storageUrl || '',
          mimeType: doc.mimeType || 'image/jpeg',
          sizeBytes: doc.sizeBytes || 0,
          thumbnailUrl: doc.thumbnailUrl || null,
          uploadConfirmed: doc.uploadConfirmed !== undefined ? doc.uploadConfirmed : false,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`Receipt ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate OcrJob collection
 */
async function migrateOcrJob() {
  const db = getDb();
  const collection = db.collection('ocrjobs');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.ocrJob.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.ocrJob.create({
        data: {
          id: uuid,
          receiptId: doc.receiptId ? utils.objectIdToUuid(doc.receiptId) : null,
          status: utils.mapOcrJobStatus(doc.status) || 'QUEUED',
          resultJson: doc.resultJson || null,
          error: doc.error || null,
          attempts: doc.attempts || 0,
          completedAt: doc.completedAt || null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`OcrJob ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate AdvanceCash collection
 */
async function migrateAdvanceCash() {
  const db = getDb();
  const collection = db.collection('advancecashes');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.advanceCash.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.advanceCash.create({
        data: {
          id: uuid,
          companyId: doc.companyId ? utils.objectIdToUuid(doc.companyId) : null,
          employeeId: doc.employeeId ? utils.objectIdToUuid(doc.employeeId) : null,
          amount: doc.amount || 0,
          balance: doc.balance || doc.amount || 0,
          currency: doc.currency || 'INR',
          status: utils.mapAdvanceCashStatus(doc.status) || 'ACTIVE',
          createdBy: doc.createdBy ? utils.objectIdToUuid(doc.createdBy) : null,
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`AdvanceCash ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

/**
 * Migrate AdvanceCashTransaction collection
 */
async function migrateAdvanceCashTransaction() {
  const db = getDb();
  const collection = db.collection('advancecashtransactions');
  const mongoDocs = await collection.find({}).toArray();
  
  let inserted = 0, skipped = 0, errors = [];
  
  for (const doc of mongoDocs) {
    try {
      const uuid = utils.objectIdToUuid(doc._id);
      const existing = await prisma.advanceCashTransaction.findUnique({ where: { id: uuid } });
      
      if (existing) {
        skipped++;
        continue;
      }
      
      await prisma.advanceCashTransaction.create({
        data: {
          id: uuid,
          employeeId: doc.employeeId ? utils.objectIdToUuid(doc.employeeId) : null,
          advanceCashId: doc.advanceCashId ? utils.objectIdToUuid(doc.advanceCashId) : null,
          expenseId: doc.expenseId ? utils.objectIdToUuid(doc.expenseId) : null,
          amount: doc.amount || 0,
          currency: doc.currency || 'INR',
          createdAt: doc.createdAt || new Date(),
          updatedAt: doc.updatedAt || new Date(),
        },
      });
      inserted++;
    } catch (error) {
      errors.push(`AdvanceCashTransaction ${doc._id}: ${error.message}`);
    }
  }
  
  return { total: mongoDocs.length, inserted, skipped, errors };
}

// Migration function mapping
const migrationFunctions = {
  Company: migrateCompany,
  User: migrateUser,
  Department: migrateDepartment,
  Role: migrateRole,
  CompanySettings: migrateCompanySettings,
  Category: migrateCategory,
  CostCentre: migrateCostCentre,
  Project: migrateProject,
  ExpenseReport: migrateExpenseReport,
  Expense: migrateExpense,
  Receipt: migrateReceipt,
  OcrJob: migrateOcrJob,
  AdvanceCash: migrateAdvanceCash,
  AdvanceCashTransaction: migrateAdvanceCashTransaction,
};

/**
 * Main migration function
 */
async function runAllMigrations() {
  console.log('========================================');
  console.log('  MongoDB → PostgreSQL Migration');
  console.log('  Complete Data Migration');
  console.log('========================================\n');
  
  try {
    // Step 1: Validate connections
    console.log('STEP 1: Validating connections...\n');
    const validationResults = await validate();
    
    if (!validationResults.mongo.success) {
      console.error('❌ MongoDB validation failed. Cannot proceed.');
      process.exit(1);
    }
    
    if (!validationResults.postgres.success) {
      console.error('❌ PostgreSQL validation failed. Cannot proceed.');
      console.error('   Please ensure the database is accessible and DATABASE_URL is correct.');
      process.exit(1);
    }
    
    // Connect to MongoDB
    await connectMongo();
    await prisma.$connect();
    
    console.log('\n\nSTEP 2: Running migrations in dependency order...\n');
    console.log('='.repeat(60));
    
    // Run migrations in order
    for (const migration of MIGRATION_ORDER) {
      console.log(`\n[${migration.step}/${MIGRATION_ORDER.length}] Migrating ${migration.model}...`);
      console.log('-'.repeat(60));
      
      try {
        const migrateFn = migrationFunctions[migration.model];
        if (!migrateFn) {
          console.log(`⚠️  No migration function found for ${migration.model}, skipping...`);
          migrationResults[migration.model] = { total: 0, inserted: 0, skipped: 0, errors: [`No migration function`] };
          continue;
        }
        
        const result = await migrateFn();
        migrationResults[migration.model] = result;
        
        console.log(`✅ ${migration.model}: ${result.inserted} inserted, ${result.skipped} skipped, ${result.errors.length} errors`);
        if (result.errors.length > 0) {
          console.log(`   First 3 errors: ${result.errors.slice(0, 3).join('; ')}`);
        }
      } catch (error) {
        console.error(`❌ ${migration.model} migration failed: ${error.message}`);
        migrationResults[migration.model] = { total: 0, inserted: 0, skipped: 0, errors: [error.message] };
      }
    }
    
    // Generate comprehensive report
    await generateReport(validationResults);
    
    // Cleanup
    await disconnectMongo();
    await prisma.$disconnect();
    
    console.log('\n✅ Migration process completed');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Migration process failed:', error.message);
    console.error(error.stack);
    await disconnectMongo().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

/**
 * Generate comprehensive migration report
 */
async function generateReport(validationResults) {
  console.log('\n\n');
  console.log('='.repeat(60));
  console.log('  COMPREHENSIVE MIGRATION REPORT');
  console.log('='.repeat(60));
  
  // 1. MongoDB Collections
  console.log('\n1. MONGODB COLLECTIONS FOUND:');
  console.log('-'.repeat(60));
  if (validationResults.mongo.success && validationResults.mongo.collections.length > 0) {
    validationResults.mongo.collections.forEach((col) => {
      const migrated = MIGRATION_ORDER.find(m => m.collection === col.name);
      const marker = migrated ? ' ✅' : ' ⏭️';
      console.log(`   ${col.name}: ${col.count} document(s)${marker}`);
    });
  }
  
  // 2. PostgreSQL Tables
  console.log('\n2. POSTGRESQL TABLES FOUND:');
  console.log('-'.repeat(60));
  if (validationResults.postgres.success && validationResults.postgres.tables.length > 0) {
    validationResults.postgres.tables.forEach((table) => {
      const count = migrationResults[table.name]?.inserted || 0;
      console.log(`   ${table.name}: ${count} row(s)`);
    });
  }
  
  // 3. Migration Results Summary
  console.log('\n3. MIGRATION RESULTS SUMMARY:');
  console.log('-'.repeat(60));
  let totalMongo = 0, totalInserted = 0, totalSkipped = 0, totalErrors = 0;
  
  MIGRATION_ORDER.forEach((migration) => {
    const result = migrationResults[migration.model] || { total: 0, inserted: 0, skipped: 0, errors: [] };
    totalMongo += result.total;
    totalInserted += result.inserted;
    totalSkipped += result.skipped;
    totalErrors += result.errors.length;
    
    const status = result.errors.length > 0 ? '⚠️' : result.inserted > 0 ? '✅' : '⏭️';
    console.log(`   ${status} ${migration.model.padEnd(25)}: ${result.inserted.toString().padStart(4)} inserted, ${result.skipped.toString().padStart(4)} skipped, ${result.errors.length} errors`);
  });
  
  console.log('\n   TOTAL:'.padEnd(28) + `${totalInserted.toString().padStart(4)} inserted, ${totalSkipped.toString().padStart(4)} skipped, ${totalErrors} errors`);
  
  // 4. Errors (if any)
  if (totalErrors > 0) {
    console.log('\n4. ERRORS ENCOUNTERED:');
    console.log('-'.repeat(60));
    MIGRATION_ORDER.forEach((migration) => {
      const result = migrationResults[migration.model];
      if (result && result.errors.length > 0) {
        console.log(`\n   ${migration.model}:`);
        result.errors.slice(0, 5).forEach((err, idx) => {
          console.log(`     ${idx + 1}. ${err}`);
        });
        if (result.errors.length > 5) {
          console.log(`     ... and ${result.errors.length - 5} more errors`);
        }
      }
    });
  }
  
  // 5. Next Steps
  console.log('\n5. NEXT STEPS:');
  console.log('-'.repeat(60));
  if (totalErrors === 0 && totalInserted > 0) {
    console.log('   ✅ All migrations completed successfully!');
    console.log('   📋 Verify data integrity in PostgreSQL');
    console.log('   📋 Update application to use PostgreSQL instead of MongoDB');
  } else if (totalErrors > 0) {
    console.log('   ⚠️  Some migrations completed with errors');
    console.log('   📋 Review errors above and fix data issues');
    console.log('   📋 Re-run migrations for failed collections');
  } else {
    console.log('   ⚠️  No data was migrated');
    console.log('   📋 Check MongoDB connection and data availability');
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('  END OF REPORT');
  console.log('='.repeat(60) + '\n');
}

// Run if called directly
if (require.main === module) {
  runAllMigrations();
}

module.exports = { runAllMigrations, migrationResults };

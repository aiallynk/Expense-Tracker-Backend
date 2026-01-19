require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { connectMongo, disconnectMongo, getDb } = require('../mongo/client');

const prisma = new PrismaClient();

/**
 * Convert MongoDB ObjectId to UUID string (deterministic)
 * @param {ObjectId|string} objectId - MongoDB ObjectId
 * @returns {string} UUID string
 */
function objectIdToUuid(objectId) {
  const hex = objectId.toString();
  // Convert 24-char hex to UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (32 hex digits total)
  // Use first 24 chars and pad with zeros for remaining 8 hex digits
  // Format: 8-4-4-4-12 hex digits
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 24)}${'0'.repeat(8)}`;
}

/**
 * Map MongoDB status enum to Prisma enum
 * @param {string} status - MongoDB status (lowercase)
 * @returns {string} Prisma status (UPPERCASE)
 */
function mapStatus(status) {
  if (!status) return 'ACTIVE'; // Default
  
  const statusMap = {
    'active': 'ACTIVE',
    'trial': 'TRIAL',
    'suspended': 'SUSPENDED',
    'inactive': 'INACTIVE',
  };
  
  return statusMap[status.toLowerCase()] || 'ACTIVE';
}

/**
 * Map MongoDB plan enum to Prisma enum
 * @param {string} plan - MongoDB plan (lowercase)
 * @returns {string} Prisma plan (UPPERCASE)
 */
function mapPlan(plan) {
  if (!plan) return 'BASIC'; // Default
  
  const planMap = {
    'free': 'FREE',
    'basic': 'BASIC',
    'professional': 'PROFESSIONAL',
    'enterprise': 'ENTERPRISE',
  };
  
  return planMap[plan.toLowerCase()] || 'BASIC';
}

/**
 * Migrate Company collection from MongoDB to PostgreSQL
 */
async function migrateCompany() {
  console.log('\n=== Company Migration ===\n');
  
  let mongoConnected = false;
  let stats = {
    total: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
  };
  
  try {
    // Connect to MongoDB
    await connectMongo();
    mongoConnected = true;
    const db = getDb();
    
    // Connect to PostgreSQL
    await prisma.$connect();
    console.log('✅ Connected to PostgreSQL via Prisma\n');
    
    // Read all companies from MongoDB
    const companiesCollection = db.collection('companies');
    const mongoCompanies = await companiesCollection.find({}).toArray();
    stats.total = mongoCompanies.length;
    
    console.log(`Found ${stats.total} company(ies) in MongoDB\n`);
    
    if (stats.total === 0) {
      console.log('⚠️  No companies found in MongoDB. Nothing to migrate.');
      return stats;
    }
    
    // Process each company
    for (let i = 0; i < mongoCompanies.length; i++) {
      const mongoCompany = mongoCompanies[i];
      
      try {
        // Convert ObjectId to UUID
        const uuid = objectIdToUuid(mongoCompany._id);
        
        // Check if company already exists (idempotent check)
        const existing = await prisma.company.findUnique({
          where: { id: uuid },
        });
        
        if (existing) {
          stats.skipped++;
          console.log(`[${i + 1}/${stats.total}] ⏭️  Skipped: ${mongoCompany.name} (already exists)`);
          continue;
        }
        
        // Map fields
        const companyData = {
          id: uuid,
          name: mongoCompany.name || 'Unnamed Company',
          status: mapStatus(mongoCompany.status),
          plan: mapPlan(mongoCompany.plan),
          createdAt: mongoCompany.createdAt || new Date(),
          updatedAt: mongoCompany.updatedAt || new Date(),
        };
        
        // Insert into PostgreSQL
        await prisma.company.create({
          data: companyData,
        });
        
        stats.inserted++;
        console.log(`[${i + 1}/${stats.total}] ✅ Inserted: ${mongoCompany.name} (${uuid})`);
        
      } catch (error) {
        const errorMsg = `Error migrating company "${mongoCompany.name}" (${mongoCompany._id}): ${error.message}`;
        stats.errors.push(errorMsg);
        console.error(`[${i + 1}/${stats.total}] ❌ ${errorMsg}`);
      }
    }
    
    // Summary
    console.log('\n=== Migration Summary ===');
    console.log(`Total MongoDB records: ${stats.total}`);
    console.log(`Inserted: ${stats.inserted}`);
    console.log(`Skipped (already exist): ${stats.skipped}`);
    console.log(`Errors: ${stats.errors.length}`);
    
    if (stats.errors.length > 0) {
      console.log('\n⚠️  Errors encountered:');
      stats.errors.forEach((err, idx) => {
        console.log(`  ${idx + 1}. ${err}`);
      });
    }
    
    // Validate results
    const postgresCount = await prisma.company.count();
    console.log(`\nPostgreSQL company count: ${postgresCount}`);
    console.log(`MongoDB company count: ${stats.total}`);
    
    if (postgresCount >= stats.total) {
      console.log('✅ Migration validation: PostgreSQL count matches or exceeds MongoDB count');
    } else {
      console.log(`⚠️  Migration validation: PostgreSQL count (${postgresCount}) is less than MongoDB count (${stats.total})`);
      console.log('   This may be expected if some records failed to migrate.');
    }
    
    return stats;
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    stats.errors.push(`Migration failed: ${error.message}`);
    throw error;
  } finally {
    // Cleanup
    if (mongoConnected) {
      await disconnectMongo();
    }
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  migrateCompany()
    .then((stats) => {
      if (stats.errors.length > 0) {
        console.error('\n⚠️  Migration completed with errors. Please review the errors above.');
        process.exit(1);
      }
      console.log('\n✅ Company migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Migration error:', error);
      process.exit(1);
    });
}

module.exports = { migrateCompany, objectIdToUuid, mapStatus, mapPlan };

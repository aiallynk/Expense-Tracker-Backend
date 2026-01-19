require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { connectMongo, disconnectMongo, getDb } = require('../mongo/client');

const prisma = new PrismaClient();

/**
 * Validate MongoDB connection and list collections
 */
async function validateMongo() {
  console.log('\n=== Validating MongoDB Connection ===');
  
  try {
    await connectMongo();
    const db = getDb();
    
    // List all collections
    const collections = await db.listCollections().toArray();
    console.log(`\nFound ${collections.length} collection(s) in MongoDB:\n`);
    
    const collectionData = [];
    
    for (const collection of collections) {
      const collectionName = collection.name;
      const count = await db.collection(collectionName).countDocuments();
      collectionData.push({
        name: collectionName,
        count: count,
      });
      console.log(`  - ${collectionName}: ${count} document(s)`);
    }
    
    console.log('\n✅ MongoDB validation completed');
    return {
      success: true,
      collections: collectionData,
    };
  } catch (error) {
    console.error('\n❌ MongoDB validation failed:', error.message);
    return {
      success: false,
      error: error.message,
      collections: [],
    };
  }
}

/**
 * Validate PostgreSQL connection and list tables
 */
async function validatePostgres() {
  console.log('\n=== Validating PostgreSQL Connection ===');
  
  try {
    // Test connection
    await prisma.$connect();
    console.log('✅ Connected to PostgreSQL via Prisma');
    
    // Get table counts - using raw SQL to list all tables
    const tables = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `;
    
    console.log(`\nFound ${tables.length} table(s) in PostgreSQL:\n`);
    
    const tableData = [];
    
    for (const table of tables) {
      const tableName = table.table_name;
      // Get count for each table
      const countResult = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      );
      const count = parseInt(countResult[0].count);
      
      tableData.push({
        name: tableName,
        count: count,
      });
      console.log(`  - ${tableName}: ${count} row(s)`);
    }
    
    console.log('\n✅ PostgreSQL validation completed');
    return {
      success: true,
      tables: tableData,
    };
  } catch (error) {
    console.error('\n❌ PostgreSQL validation failed:', error.message);
    return {
      success: false,
      error: error.message,
      tables: [],
    };
  }
}

/**
 * Main validation function
 */
async function validate() {
  console.log('========================================');
  console.log('  MongoDB → PostgreSQL Migration');
  console.log('  Validation Script');
  console.log('========================================\n');
  
  const mongoResult = await validateMongo();
  const postgresResult = await validatePostgres();
  
  // Cleanup
  await disconnectMongo();
  await prisma.$disconnect();
  
  // Return results
  return {
    mongo: mongoResult,
    postgres: postgresResult,
  };
}

// Run if called directly
if (require.main === module) {
  validate()
    .then((results) => {
      if (!results.mongo.success || !results.postgres.success) {
        console.error('\n❌ Validation failed. Please check your connections.');
        process.exit(1);
      }
      console.log('\n✅ All validations passed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Validation error:', error);
      process.exit(1);
    });
}

module.exports = { validate, validateMongo, validatePostgres };

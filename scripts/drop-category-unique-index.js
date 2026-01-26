/**
 * Migration Script: Drop Unique Index on Categories
 * 
 * This script drops the unique index on (companyId, name) from the categories collection
 * to allow duplicate category names within the same company.
 * 
 * Run this script once to update existing databases:
 * node scripts/drop-category-unique-index.js
 * 
 * Or run in MongoDB shell:
 * db.categories.dropIndex("companyId_1_name_1")
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function dropCategoryUniqueIndex() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    const dbName = process.env.MONGODB_DB_NAME || 'expense_tracker';
    
    await mongoose.connect(mongoUri, {
      dbName: dbName,
    });
    
    console.log('Connected to MongoDB');
    
    const db = mongoose.connection.db;
    const collection = db.collection('categories');
    
    // List all indexes
    const indexes = await collection.indexes();
    console.log('Current indexes on categories collection:');
    indexes.forEach(index => {
      console.log('  -', JSON.stringify(index));
    });
    
    // Check if unique index exists
    const uniqueIndex = indexes.find(
      idx => idx.key && idx.key.companyId === 1 && idx.key.name === 1 && idx.unique === true
    );
    
    if (uniqueIndex) {
      console.log('\nFound unique index on (companyId, name). Dropping it...');
      await collection.dropIndex('companyId_1_name_1');
      console.log('✓ Unique index dropped successfully');
      console.log('Categories can now have duplicate names within the same company.');
    } else {
      console.log('\nNo unique index found on (companyId, name).');
      console.log('The index may have already been dropped or never existed.');
    }
    
    // Verify indexes after drop
    const indexesAfter = await collection.indexes();
    console.log('\nIndexes after migration:');
    indexesAfter.forEach(index => {
      console.log('  -', JSON.stringify(index));
    });
    
    await mongoose.disconnect();
    console.log('\n✓ Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error during migration:', error);
    process.exit(1);
  }
}

// Run migration
dropCategoryUniqueIndex();

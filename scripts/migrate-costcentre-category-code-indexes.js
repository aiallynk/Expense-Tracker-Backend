/**
 * Migration Script: Cost Centre and Category code indexes - company-scoped
 *
 * - Drops global unique index on code (code_1) from costcentres and categories.
 * - Creates composite unique partial index (companyId, code) on both collections.
 *   Only indexes documents with code set (excludes code: null). Same code allowed across
 *   companies; duplicate code blocked within same company.
 *
 * Idempotent: safe to run multiple times.
 *
 * Run: node scripts/migrate-costcentre-category-code-indexes.js
 * Requires: MONGODB_URI, MONGODB_DB_NAME in .env (or defaults)
 */

const mongoose = require('mongoose');
require('dotenv').config();

const COSTCENTRES_COLLECTION = 'costcentres';
const CATEGORIES_COLLECTION = 'categories';
const CODE_INDEX_NAME = 'code_1';
const COMPOSITE_CODE_INDEX_NAME = 'companyId_1_code_1';

async function migrateCollectionCodeIndex(db, collectionName) {
  const collection = db.collection(collectionName);

  const indexes = await collection.indexes();
  console.log(`\nCurrent indexes on ${collectionName}:`);
  indexes.forEach((idx) =>
    console.log('  -', idx.name, JSON.stringify(idx.key), idx.unique ? '(unique)' : '', idx.sparse ? '(sparse)' : '')
  );

  // 1. Drop global unique index on code only (code_1) if exists
  const codeIndex = indexes.find((idx) => idx.name === CODE_INDEX_NAME);
  if (codeIndex) {
    console.log(`\nDropping global unique index ${CODE_INDEX_NAME} from ${collectionName}...`);
    try {
      await collection.dropIndex(CODE_INDEX_NAME);
      console.log(`Dropped ${CODE_INDEX_NAME} from ${collectionName}.`);
    } catch (err) {
      if (err.codeName === 'IndexNotFound') {
        console.log(`Index ${CODE_INDEX_NAME} not found (already dropped).`);
      } else {
        throw err;
      }
    }
  } else {
    console.log(`\nNo ${CODE_INDEX_NAME} index found on ${collectionName} (skip drop).`);
  }

  // 2. Ensure composite unique sparse (companyId, code) exists
  const afterDrop = await collection.indexes();
  const existingComposite = afterDrop.find(
    (idx) =>
      idx.key &&
      idx.key.companyId === 1 &&
      idx.key.code === 1
  );

  const partialFilter = { code: { $gt: '' } };
  const hasCorrectPartial = existingComposite?.partialFilterExpression &&
    JSON.stringify(existingComposite.partialFilterExpression) === JSON.stringify(partialFilter);

  if (existingComposite && existingComposite.unique === true && hasCorrectPartial) {
    console.log(`Composite unique partial index (companyId, code) already exists on ${collectionName}.`);
  } else {
    if (existingComposite) {
      console.log(`Dropping existing (companyId, code) index before creating...`);
      try {
        await collection.dropIndex(existingComposite.name);
      } catch (err) {
        if (err.codeName !== 'IndexNotFound') throw err;
      }
    }
    console.log(`Creating composite unique partial index (companyId, code) on ${collectionName}...`);
    await collection.createIndex(
      { companyId: 1, code: 1 },
      {
        unique: true,
        name: COMPOSITE_CODE_INDEX_NAME,
        partialFilterExpression: partialFilter,
      }
    );
    console.log(`Composite unique partial index (companyId, code) created on ${collectionName}.`);
  }

  const final = await collection.indexes();
  console.log(`\nIndexes after migration on ${collectionName}:`);
  final.forEach((idx) =>
    console.log('  -', idx.name, JSON.stringify(idx.key), idx.unique ? '(unique)' : '', idx.partialFilterExpression ? '(partial)' : '')
  );
}

async function runMigration() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    const dbName = process.env.MONGODB_DB_NAME || 'expense_tracker';

    await mongoose.connect(mongoUri, { dbName });
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;

    await migrateCollectionCodeIndex(db, COSTCENTRES_COLLECTION);
    await migrateCollectionCodeIndex(db, CATEGORIES_COLLECTION);

    await mongoose.disconnect();
    console.log('\nMigration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigration();

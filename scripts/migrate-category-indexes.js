/**
 * Migration Script: Category indexes per company
 *
 * - Drops any global unique index on category name (so same name is allowed across companies).
 * - Creates composite unique index on (companyId, name) (duplicate names blocked within same company).
 *
 * Idempotent: safe to run multiple times.
 *
 * Run: node scripts/migrate-category-indexes.js
 * Requires: MONGODB_URI, MONGODB_DB_NAME in .env (or defaults)
 */

const mongoose = require('mongoose');
require('dotenv').config();

const COLLECTION = 'categories';
const COMPOSITE_INDEX_NAME = 'companyId_1_name_1';

async function migrateCategoryIndexes() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    const dbName = process.env.MONGODB_DB_NAME || 'expense_tracker';

    await mongoose.connect(mongoUri, { dbName });
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection(COLLECTION);

    const indexes = await collection.indexes();
    console.log('Current indexes on', COLLECTION + ':');
    indexes.forEach((idx) => console.log('  -', idx.name, JSON.stringify(idx.key), idx.unique ? '(unique)' : ''));

    // 1. Drop global unique index on name only (if exists)
    const globalNameUnique = indexes.find(
      (idx) => idx.key && idx.key.name === 1 && Object.keys(idx.key).length === 1 && idx.unique === true
    );
    if (globalNameUnique) {
      console.log('\nDropping global unique index on name:', globalNameUnique.name);
      await collection.dropIndex(globalNameUnique.name).catch((err) => {
        if (err.codeName === 'IndexNotFound') return;
        throw err;
      });
      console.log('Dropped global unique index on name.');
    } else {
      console.log('\nNo global unique index on name found (skip drop).');
    }

    // 2. Ensure composite unique (companyId, name) exists
    const existingComposite = indexes.find(
      (idx) =>
        idx.key &&
        idx.key.companyId === 1 &&
        idx.key.name === 1 &&
        (idx.unique === true || idx.name === COMPOSITE_INDEX_NAME)
    );
    if (existingComposite && existingComposite.unique === true) {
      console.log('Composite unique index (companyId, name) already exists.');
    } else {
      if (existingComposite && !existingComposite.unique) {
        console.log('Dropping non-unique (companyId, name) index before creating unique...');
        await collection.dropIndex(COMPOSITE_INDEX_NAME).catch((err) => {
          if (err.codeName === 'IndexNotFound') return;
          throw err;
        });
      }
      console.log('Creating composite unique index: companyId_1, name_1');
      await collection.createIndex(
        { companyId: 1, name: 1 },
        { unique: true, name: COMPOSITE_INDEX_NAME }
      );
      console.log('Composite unique index (companyId, name) created.');
    }

    const after = await collection.indexes();
    console.log('\nIndexes after migration:');
    after.forEach((idx) => console.log('  -', idx.name, JSON.stringify(idx.key), idx.unique ? '(unique)' : ''));

    await mongoose.disconnect();
    console.log('\nMigration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrateCategoryIndexes();

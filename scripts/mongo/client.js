require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;

if (!MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required');
}

if (!MONGODB_DB_NAME) {
  throw new Error('MONGODB_DB_NAME environment variable is required');
}

let client = null;
let db = null;

/**
 * Connect to MongoDB using native driver
 * @returns {Promise<{client: MongoClient, db: Db}>}
 */
async function connectMongo() {
  if (client && db) {
    return { client, db };
  }

  try {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    await client.connect();
    console.log('✅ Connected to MongoDB');

    // Get database
    db = client.db(MONGODB_DB_NAME);
    console.log(`✅ Using database: ${MONGODB_DB_NAME}`);

    return { client, db };
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error.message);
    throw error;
  }
}

/**
 * Disconnect from MongoDB
 */
async function disconnectMongo() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('✅ Disconnected from MongoDB');
  }
}

/**
 * Get MongoDB database instance (must be connected first)
 * @returns {Db}
 */
function getDb() {
  if (!db) {
    throw new Error('MongoDB not connected. Call connectMongo() first.');
  }
  return db;
}

module.exports = {
  connectMongo,
  disconnectMongo,
  getDb,
};

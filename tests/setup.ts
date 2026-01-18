/// <reference types="jest" />
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer: MongoMemoryServer;

// Setup test environment variables (no hardcoded secrets)
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret-key-for-testing-only';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-key-for-testing-only';
process.env.JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
process.env.JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret-key';
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
process.env.APP_ENV = 'test';

// Setup before all tests
beforeAll(async () => {
  // Start in-memory MongoDB instance for 100% test isolation
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  
  await mongoose.connect(mongoUri);
});

// Cleanup after each test - ensure complete isolation
afterEach(async () => {
  // Clear all collections to prevent test interference
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
  
  // Reset S3 mocks if they exist
  try {
    const { resetS3Mocks } = require('./utils/s3Mock');
    resetS3Mocks();
  } catch (error) {
    // S3 mocks may not be initialized in all tests, ignore
  }
});

// Cleanup after all tests
afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

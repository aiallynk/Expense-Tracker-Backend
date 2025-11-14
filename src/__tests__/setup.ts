// Test setup file
// This file runs before all tests

// Mock environment variables
process.env.JWT_ACCESS_SECRET = 'test_access_secret';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test_db';
process.env.MONGODB_DB_NAME = 'test_db';


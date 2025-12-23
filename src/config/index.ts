import dotenv from 'dotenv';

import { validateEnv } from './env';

// Load environment variables
dotenv.config();

// Validate environment variables (fail fast if invalid)
// Must be called before importing logger to avoid circular dependency
validateEnv();

export const config = {
  app: {
    env: process.env.APP_ENV || 'development',
    // Render provides PORT environment variable, fallback to APP_PORT or 4000
    port: parseInt(process.env.PORT || process.env.APP_PORT || '4000', 10),
    frontendUrlApp: process.env.APP_FRONTEND_URL_APP || 'http://localhost:3000',
    frontendUrlAdmin: process.env.APP_FRONTEND_URL_ADMIN || 'http://localhost:3001',
  },
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    dbName: process.env.MONGODB_DB_NAME || 'expense_tracker',
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'changeme',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'changeme',
    // For testing: Set to very long expiration (100 years) - change back to '15m' for production
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '100y',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '100y',
  },
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    s3BucketName: process.env.S3_BUCKET_NAME || 'expense-tracker-aially',
  },
  togetherAI: {
    apiKey: process.env.TOGETHER_AI_API_KEY || '',
    userKey: process.env.TOGETHER_AI_USER_KEY || '',
    // Default to a serverless vision model
    // User can override with TOGETHER_AI_MODEL_VISION in .env
    // Note: Some models require dedicated endpoints - check Together AI docs
    modelVision: process.env.TOGETHER_AI_MODEL_VISION || 'Qwen/Qwen2.5-VL-72B-Instruct',
    baseUrl: 'https://api.together.xyz/v1',
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
    databaseUrl: process.env.FIREBASE_DATABASE_URL || '',
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.RESEND_FROM_EMAIL || 'no-reply@aially.in',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
  },
  ocr: {
    disableOcr: process.env.DISABLE_OCR === 'true',
    queueName: 'ocr-jobs',
    concurrency: parseInt(process.env.OCR_WORKER_CONCURRENCY || '3', 10),
  },
};


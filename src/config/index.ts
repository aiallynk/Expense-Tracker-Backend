import dotenv from 'dotenv';

import { validateEnv } from './env';

dotenv.config();
validateEnv();

export const config = {
  app: {
    env: process.env.APP_ENV || 'development',
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
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '100y',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '100y',
  },
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    s3BucketName: process.env.S3_BUCKET_NAME || 'expense-tracker-aially',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    modelVision: process.env.OPENAI_MODEL_VISION || 'gpt-4o',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
    databaseUrl: process.env.FIREBASE_DATABASE_URL || '',
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.MAIL_FROM || process.env.RESEND_FROM_EMAIL || 'no-reply@nexpense.aially.in',
  },
  frontend: {
    url: process.env.FRONTEND_URL || 'https://nexpense.aially.in',
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
    // Increased default concurrency for high-volume processing
    // Supports 100K+ users with multiple OCR workers
    concurrency: parseInt(process.env.OCR_WORKER_CONCURRENCY || '20', 10), // Increased from 3 to 20
  },
  ai: {
    disableCategoryMatching: process.env.DISABLE_AI_CATEGORY_MATCHING === 'true',
  },
  analytics: {
    // Trim whitespace and newlines from API key
    // This prevents issues with .env files that may have trailing newlines
    apiKey: (process.env.ANALYTICS_API_KEY || '').trim().replace(/\r?\n/g, ''),
  },
};

// Log analytics API key status at startup (length only, not value)
if (config.analytics.apiKey && config.analytics.apiKey.length > 0) {
  console.log(`[CONFIG] Analytics API Key loaded (length: ${config.analytics.apiKey.length} characters)`);
} else {
  console.warn('[CONFIG] WARNING: ANALYTICS_API_KEY not configured or empty');
}

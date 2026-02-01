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
    demoMode: process.env.DEMO_MODE === 'true',
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
    modelVision: process.env.OPENAI_MODEL_VISION || 'gpt-4o-mini',
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
    // Global concurrency limit: max 20 concurrent OCR jobs across all users
    concurrency: parseInt(process.env.OCR_CONCURRENCY || '20', 10),
    // Per-user concurrency limit: max 3 concurrent OCR jobs per user
    perUserConcurrency: parseInt(process.env.OCR_PER_USER_CONCURRENCY || '3', 10),
    // Global throttling limit: max concurrent OCR jobs globally (from env)
    maxGlobalOcr: parseInt(process.env.MAX_GLOBAL_OCR || process.env.OCR_CONCURRENCY || '20', 10),
    // Per-user throttling limit: max concurrent OCR jobs per user (from env)
    maxPerUserOcr: parseInt(process.env.MAX_PER_USER_OCR || process.env.OCR_PER_USER_CONCURRENCY || '3', 10),
    // Traffic-aware dispatcher: BLAST (low traffic) vs CONTROLLED (high traffic)
    // BLAST: batch completion time ~ MAX(single receipt time). Per-user >= 10 so 10 receipts start in parallel.
    blast: {
      maxGlobalOcr: parseInt(process.env.OCR_BLAST_MAX_GLOBAL || process.env.MAX_GLOBAL_OCR || '40', 10),
      maxPerUserOcr: parseInt(process.env.OCR_BLAST_MAX_PER_USER || process.env.MAX_PER_USER_OCR || '10', 10),
    },
    controlled: {
      maxGlobalOcr: parseInt(process.env.OCR_CONTROLLED_MAX_GLOBAL || process.env.MAX_GLOBAL_OCR || '20', 10),
      maxPerUserOcr: parseInt(process.env.OCR_CONTROLLED_MAX_PER_USER || process.env.MAX_PER_USER_OCR || '3', 10),
    },
    // Thresholds: switch to CONTROLLED when active users or active OCR jobs exceed these
    activeUsersBlastThreshold: parseInt(process.env.OCR_ACTIVE_USERS_BLAST_THRESHOLD || '10', 10),
    activeOcrJobsControlledThreshold: parseInt(process.env.OCR_ACTIVE_JOBS_CONTROLLED_THRESHOLD || '50', 10),
    // Single retry on failure (manual retry via UI, not automatic)
    retry: 1,
    // Max automatic retry attempts for transient failures (429, 5xx, timeout)
    retryMaxAttempts: parseInt(process.env.OCR_RETRY_MAX_ATTEMPTS || '3', 10),
    // Base delay in ms for exponential backoff (1s, 2s, 4s, ...)
    retryBackoffBaseMs: parseInt(process.env.OCR_RETRY_BACKOFF_BASE_MS || '1000', 10),
    // 30 second timeout per receipt
    timeout: 30000,
    // OCR timeout in milliseconds (from env, defaults to 30s)
    timeoutMs: parseInt(process.env.OCR_TIMEOUT_MS || '30000', 10),
    // Demo mode: silently ignore OCR failures
    demoMode: process.env.OCR_DEMO_MODE === 'true',
    // Below this → "Needs Review"; no auto category/date (plan §5)
    confidenceThreshold: parseFloat(process.env.OCR_CONFIDENCE_THRESHOLD || '0.75'),
  },
  ai: {
    disableCategoryMatching: process.env.DISABLE_AI_CATEGORY_MATCHING === 'true',
    categoryConfidenceThreshold: parseFloat(process.env.AI_CATEGORY_CONFIDENCE_THRESHOLD || '0.6'),
  },
  analytics: {
    // Trim whitespace and newlines from API key
    // This prevents issues with .env files that may have trailing newlines
    apiKey: (process.env.ANALYTICS_API_KEY || '').trim().replace(/\r?\n/g, ''),
  },
  ingest: {
    // Ingest service URL (for debug logging - development only)
    serviceUrl: process.env.INGEST_SERVICE_URL || 'http://127.0.0.1:7244',
    // Enable ingest endpoint (disabled in production by default for security)
    enabled: process.env.INGEST_ENABLED === 'true' || process.env.APP_ENV === 'development',
  },
};

// Log analytics API key status at startup (length only, not value)
// Note: Using logger here would cause circular dependency, so we use console only in non-production
if (config.app.env !== 'production') {
  if (config.analytics.apiKey && config.analytics.apiKey.length > 0) {
    console.log(`[CONFIG] Analytics API Key loaded (length: ${config.analytics.apiKey.length} characters)`);
  } else {
    console.warn('[CONFIG] WARNING: ANALYTICS_API_KEY not configured or empty');
  }
}

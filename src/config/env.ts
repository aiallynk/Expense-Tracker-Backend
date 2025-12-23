import { z } from 'zod';

/**
 * Environment variable validation schema
 * Validates all required and optional environment variables at startup
 * Fails fast with clear error messages if validation fails
 */
const envSchema = z.object({
  // Application
  APP_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().optional(),
  APP_PORT: z.string().optional(),
  APP_FRONTEND_URL_APP: z.string().url().optional(),
  APP_FRONTEND_URL_ADMIN: z.string().url().optional(),

  // MongoDB
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().min(1, 'MONGODB_DB_NAME is required'),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // AWS S3
  AWS_REGION: z.string().default('ap-south-1'),
  S3_BUCKET_NAME: z.string().min(1, 'S3_BUCKET_NAME is required'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID is required'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY is required'),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_VISION: z.string().default('gpt-4o'),
  OPENAI_BASE_URL: z.string().url().optional(),

  // Firebase (optional)
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_DATABASE_URL: z.string().optional(),

  // Resend (optional)
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379'),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.string().default('0'),

  // OCR Worker
  DISABLE_OCR: z.string().optional(),
  OCR_WORKER_CONCURRENCY: z.string().default('3'),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z.string().optional(),
  REQUEST_ID_HEADER: z.string().default('X-Request-ID'),
});

/**
 * Validate environment variables
 * Called at application startup - fails fast if validation fails
 */
export function validateEnv(): void {
  try {
    envSchema.parse(process.env);
    // Logger will be initialized after this validation completes
    // Using console.log here to avoid circular dependency during initialization
    if (process.env.NODE_ENV !== 'production') {
      console.log('✅ Environment variables validated successfully');
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.errors.map((err) => ({
        path: err.path.join('.'),
        message: err.message,
      }));

      // Use console.error for critical startup errors (logger may not be initialized due to circular dependency)
      console.error('\n❌ Environment variable validation failed:\n');
      errors.forEach((err) => {
        console.error(`  ${err.path}: ${err.message}`);
      });
      console.error('\nPlease check your .env file and ensure all required variables are set.\n');
      process.exit(1);
    } else {
      // Use console.error for critical startup errors
      console.error('Unexpected error during environment validation:', error);
      process.exit(1);
    }
  }
}


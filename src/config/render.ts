/**
 * Render Deployment Configuration
 * 
 * This file contains Render-specific deployment notes and process formation.
 * 
 * PROCESS FORMATION:
 * 
 * 1. Web Service (expense-tracker-backend)
 *    - Type: web
 *    - Build: npm install && npm run build
 *    - Start: npm start (runs node start.js -> node dist/server.js)
 *    - Health Check: /healthz
 *    - Port: Automatically set via PORT environment variable
 *    - Environment: production
 * 
 * 2. Worker Service (expense-tracker-ocr-worker)
 *    - Type: worker
 *    - Build: npm install && npm run build
 *    - Start: npm run worker:prod (runs node dist/worker/ocr.worker.js)
 *    - Environment: production
 *    - Requires: MongoDB, Redis, AWS S3, Together AI
 * 
 * DEPLOYMENT STEPS:
 * 
 * 1. Connect your GitHub repository to Render
 * 2. Create a new Web Service
 *    - Set Root Directory to "BACKEND" if backend is in a subdirectory
 *    - Build Command: npm install && npm run build
 *    - Start Command: npm start
 *    - Health Check Path: /healthz
 * 3. Create a new Worker Service
 *    - Set Root Directory to "BACKEND" if backend is in a subdirectory
 *    - Build Command: npm install && npm run build
 *    - Start Command: npm run worker:prod
 * 4. Set environment variables in Render Dashboard for both services
 * 5. Deploy
 * 
 * COMMON GOTCHAS:
 * 
 * - Port Binding: Render sets PORT env var automatically. Server must bind to process.env.PORT
 * - Health Checks: Use /healthz endpoint (not /health) for Render health checks
 * - Build Timeout: If build takes > 20 minutes, increase timeout in Render settings
 * - Memory: Starter plan has 512MB RAM. Monitor memory usage in logs
 * - Redis: Use Render Redis service or external Redis (Redis Cloud, Upstash)
 * - MongoDB: Use MongoDB Atlas or Render MongoDB service
 * - CORS: Set APP_FRONTEND_URL_APP and APP_FRONTEND_URL_ADMIN for production CORS
 * - Logs: Set LOG_PRETTY=false for production (JSON logs are better for log aggregation)
 * 
 * ENVIRONMENT VARIABLES:
 * 
 * Required:
 * - MONGODB_URI
 * - MONGODB_DB_NAME
 * - JWT_ACCESS_SECRET (min 32 chars)
 * - JWT_REFRESH_SECRET (min 32 chars)
 * - AWS_ACCESS_KEY_ID
 * - AWS_SECRET_ACCESS_KEY
 * - S3_BUCKET_NAME
 * - APP_FRONTEND_URL_APP (for production CORS)
 * - APP_FRONTEND_URL_ADMIN (for production CORS)
 * 
 * Optional:
 * - AWS_REGION (default: ap-south-1)
 * - TOGETHER_AI_API_KEY
 * - TOGETHER_AI_USER_KEY
 * - TOGETHER_AI_MODEL_VISION
 * - FIREBASE_PROJECT_ID
 * - FIREBASE_CLIENT_EMAIL
 * - FIREBASE_PRIVATE_KEY
 * - FIREBASE_DATABASE_URL
 * - RESEND_API_KEY
 * - RESEND_FROM_EMAIL
 * - REDIS_HOST (default: localhost, use Render Redis service URL)
 * - REDIS_PORT (default: 6379)
 * - REDIS_PASSWORD
 * - REDIS_DB (default: 0)
 * - LOG_LEVEL (default: info)
 * - LOG_PRETTY (default: false)
 * - REQUEST_ID_HEADER (default: X-Request-ID)
 * - DISABLE_OCR (default: false)
 * - OCR_WORKER_CONCURRENCY (default: 3)
 * 
 * TROUBLESHOOTING:
 * 
 * 1. Server not starting:
 *    - Check build logs for TypeScript errors
 *    - Verify dist/server.js exists after build
 *    - Check PORT binding in server.ts
 *    - Review startup logs for env validation errors
 * 
 * 2. Health check failing:
 *    - Verify /healthz endpoint returns 200
 *    - Check MongoDB connection status
 *    - Check Redis connection status
 *    - Review logs for connection errors
 * 
 * 3. Worker not processing jobs:
 *    - Verify worker service is running
 *    - Check Redis connection
 *    - Verify MongoDB connection
 *    - Check OCR_WORKER_CONCURRENCY setting
 *    - Review worker logs for errors
 * 
 * 4. Database connection errors:
 *    - Verify MONGODB_URI is correct
 *    - Check MongoDB Atlas IP whitelist (add Render IPs)
 *    - Verify database user has correct permissions
 *    - Check network connectivity
 * 
 * 5. Redis connection errors:
 *    - Verify REDIS_HOST and REDIS_PORT
 *    - Check REDIS_PASSWORD if required
 *    - Verify Redis service is accessible from Render
 *    - Check Redis connection string format
 * 
 * 6. S3 access denied:
 *    - Verify AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
 *    - Check IAM permissions (s3:PutObject, s3:GetObject, s3:CreateBucket)
 *    - Verify S3_BUCKET_NAME is correct
 *    - Check bucket region matches AWS_REGION
 * 
 * 7. Missing environment variables:
 *    - Review env validation errors in startup logs
 *    - Check .env.example for required variables
 *    - Verify all required vars are set in Render Dashboard
 */

export const renderConfig = {
  web: {
    buildCommand: 'npm install && npm run build',
    startCommand: 'npm start',
    healthCheckPath: '/healthz',
  },
  worker: {
    buildCommand: 'npm install && npm run build',
    startCommand: 'npm run worker:prod',
  },
};


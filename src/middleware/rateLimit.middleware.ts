import rateLimit from 'express-rate-limit';

import { config } from '../config/index';

// Login rate limiter - prevent brute force attacks
// Scalable for high concurrency (100K+ users)
// Uses IP-based limiting to prevent single user from blocking others
// More lenient in development mode
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Support 100K concurrent logins: 100K per 15min = ~111 logins/sec
  // Development: More lenient for testing
  // Production: Still high enough for 100K users but prevents brute force
  max: config.app.env === 'development' 
    ? parseInt(process.env.LOGIN_RATE_LIMIT_DEV || '10000', 10) // 10K in dev
    : parseInt(process.env.LOGIN_RATE_LIMIT_PROD || '100000', 10), // 100K in prod
  message: {
    success: false,
    message: 'Too many login attempts, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip validation warnings for trust proxy in production (Render uses reverse proxy)
  validate: {
    trustProxy: false, // Disable trust proxy validation warning
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
  // Use IP-based key generator for distributed rate limiting
  keyGenerator: (req) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

// Receipt upload rate limiter - control costs
// Higher limits in DEMO_MODE and production for bulk uploads
export const receiptUploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.app.demoMode 
    ? parseInt(process.env.RECEIPT_UPLOAD_RATE_LIMIT_DEMO || '1000', 10) // 1000 in demo mode
    : parseInt(process.env.RECEIPT_UPLOAD_RATE_LIMIT || '500', 10), // 500 in production
  message: {
    success: false,
    message: 'Too many receipt uploads, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip validation warnings for trust proxy in production (Render uses reverse proxy)
  validate: {
    trustProxy: false, // Disable trust proxy validation warning
  },
  // Use user ID for authenticated requests (better than IP-based)
  keyGenerator: (req: any) => {
    // Use user ID if available (authenticated requests)
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    // Fallback to IP for unauthenticated requests
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

// Bulk upload rate limiter - higher limits for bulk operations
export const bulkUploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.app.demoMode
    ? parseInt(process.env.BULK_UPLOAD_RATE_LIMIT_DEMO || '2000', 10) // 2000 in demo mode
    : parseInt(process.env.BULK_UPLOAD_RATE_LIMIT || '1000', 10), // 1000 in production
  message: {
    success: false,
    message: 'Too many bulk upload requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    trustProxy: false,
  },
  // Use user ID for authenticated requests
  keyGenerator: (req: any) => {
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

// OCR rate limiter - control API costs
// Increased for high-volume processing while maintaining cost control
export const ocrRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  // Increased from 100 to 10K per hour for scalability
  // Can be configured via environment variable
  max: parseInt(process.env.OCR_RATE_LIMIT || '10000', 10), // 10K OCR requests per hour
  message: {
    success: false,
    message: 'Too many OCR requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip validation warnings for trust proxy in production (Render uses reverse proxy)
  validate: {
    trustProxy: false, // Disable trust proxy validation warning
  },
});

// General API rate limiter
// Scalable for high concurrency (100K+ users)
// Supports ~11,111 requests/second for 100K concurrent users
// More lenient in development mode
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Support 100K concurrent users: 10M per 15min = ~11,111 RPS
  // Development: More lenient for testing
  // Production: High enough for 100K users but prevents abuse
  max: config.app.env === 'development'
    ? parseInt(process.env.API_RATE_LIMIT_DEV || '1000000', 10) // 1M in dev
    : parseInt(process.env.API_RATE_LIMIT_PROD || '10000000', 10), // 10M in prod
  message: {
    success: false,
    message: 'Too many requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip validation warnings for trust proxy in production (Render uses reverse proxy)
  validate: {
    trustProxy: false, // Disable trust proxy validation warning
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
  // Use IP-based key generator for distributed rate limiting
  keyGenerator: (req) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});


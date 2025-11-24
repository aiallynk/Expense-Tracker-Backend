import rateLimit from 'express-rate-limit';

import { config } from '../config/index';

// Login rate limiter - prevent brute force attacks
// More lenient in development mode
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.app.env === 'development' ? 50 : 5, // 50 attempts in dev, 5 in production
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
});

// Receipt upload rate limiter - control costs
export const receiptUploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 uploads per hour
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
});

// OCR rate limiter - control API costs
export const ocrRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // 100 OCR requests per hour
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
// More lenient in development mode
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.app.env === 'development' ? 1000 : 100, // 1000 requests in dev, 100 in production
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
});


import { Request, Response, NextFunction } from 'express';

import { config } from '../config/index';
import { logger } from '@/config/logger';

export interface AnalyticsRequest extends Request {
  companyId?: string; // Company ID from query param or fixed value
}

/**
 * Analytics Authentication Middleware
 * 
 * Validates ONLY x-api-key header against ANALYTICS_API_KEY from environment.
 * No JWT required - designed for Microsoft Fabric / Power BI integration.
 * 
 * Security:
 * - Only accepts GET requests (read-only)
 * - Validates API key from environment variable
 * - Extracts companyId from query params for data scoping
 */
/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Sanitize URL by removing newlines and carriage returns
 * Prevents path injection attacks like /dashboard%0A
 */
function sanitizeUrl(url: string): string {
  return url
    .replace(/%0A/gi, '') // Remove newline (%0A)
    .replace(/%0D/gi, '') // Remove carriage return (%0D)
    .replace(/\r/g, '')   // Remove literal \r
    .replace(/\n/g, '');  // Remove literal \n
}

export const analyticsAuthMiddleware = async (
  req: AnalyticsRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Sanitize URL to prevent path injection
    // Note: req.path and req.url are read-only, so we check for malicious patterns
    const sanitizedPath = sanitizeUrl(req.path || req.url || '');
    if (sanitizedPath !== req.path && sanitizedPath !== req.url) {
      logger.warn(
        { originalPath: req.path, sanitizedPath },
        'Analytics endpoint - Malicious path detected and blocked'
      );
      res.status(400).json({
        success: false,
        message: 'Invalid path format',
        code: 'INVALID_PATH',
      });
      return;
    }

    // Enforce read-only (GET only)
    if (req.method !== 'GET') {
      logger.warn(
        { method: req.method, path: req.path },
        'Analytics endpoint - Non-GET request rejected'
      );
      res.status(405).json({
        success: false,
        message: 'Analytics endpoints are read-only (GET only)',
        code: 'METHOD_NOT_ALLOWED',
      });
      return;
    }

    // Check for API key (support both lowercase and uppercase header names)
    // Express normalizes headers to lowercase, but some clients may send uppercase
    const apiKey = (req.headers['x-api-key'] || req.headers['X-API-Key'] || req.headers['X-API-KEY']) as string | undefined;

    if (!apiKey) {
      logger.warn(
        { method: req.method, path: req.path },
        'Analytics endpoint - Missing x-api-key header'
      );
      res.status(401).json({
        success: false,
        message: 'API key required. Provide x-api-key header.',
        code: 'MISSING_API_KEY',
      });
      return;
    }

    // Trim and sanitize API key from header
    const sanitizedApiKey = apiKey.trim().replace(/\r?\n/g, '');

    // Validate against environment variable
    const expectedApiKey = config.analytics.apiKey;

    if (!expectedApiKey || expectedApiKey.length === 0) {
      logger.error('ANALYTICS_API_KEY not configured in environment');
      res.status(500).json({
        success: false,
        message: 'Analytics API not configured',
        code: 'CONFIGURATION_ERROR',
      });
      return;
    }

    // Use constant-time comparison to prevent timing attacks
    if (!constantTimeCompare(sanitizedApiKey, expectedApiKey)) {
      logger.warn(
        { method: req.method, path: req.path },
        'Analytics endpoint - Invalid API key'
      );
      res.status(401).json({
        success: false,
        message: 'Invalid API key',
        code: 'INVALID_API_KEY',
      });
      return;
    }

    // Extract and validate companyId from query params (REQUIRED for data scoping)
    const companyId = req.query.companyId as string | undefined;
    
    if (!companyId || companyId.trim().length === 0) {
      logger.warn(
        { method: req.method, path: req.path },
        'Analytics request - Missing required companyId query parameter'
      );
      res.status(400).json({
        success: false,
        message: 'companyId query parameter is required for data scoping',
        code: 'MISSING_COMPANY_ID',
      });
      return;
    }

    // Sanitize companyId (remove newlines, trim whitespace)
    const sanitizedCompanyId = companyId.trim().replace(/\r?\n/g, '');
    
    // Validate companyId format (should be a valid MongoDB ObjectId format)
    if (!/^[a-f\d]{24}$/i.test(sanitizedCompanyId)) {
      logger.warn(
        { method: req.method, path: req.path, companyId: sanitizedCompanyId },
        'Analytics request - Invalid companyId format'
      );
      res.status(400).json({
        success: false,
        message: 'Invalid companyId format. Must be a valid MongoDB ObjectId.',
        code: 'INVALID_COMPANY_ID',
      });
      return;
    }

    req.companyId = sanitizedCompanyId;

    // Log successful authentication (without sensitive data)
    logger.info(
      {
        method: req.method,
        path: req.path,
        companyId: req.companyId,
      },
      'Analytics API request authenticated'
    );

    next();
  } catch (error) {
    logger.error({ error }, 'Analytics auth middleware error');
    res.status(500).json({
      success: false,
      message: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
};


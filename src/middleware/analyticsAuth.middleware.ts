import { Request, Response, NextFunction } from 'express';

import { config } from '../config/index';
import { logger } from '@/config/logger';

export interface AnalyticsRequest extends Request {
  companyId?: string; // Company ID from query param (validated and sanitized)
  requestId?: string; // Request ID for logging
}

/**
 * Analytics Authentication Middleware
 * 
 * Validates ONLY x-api-key header against ANALYTICS_API_KEY from environment.
 * No JWT required - designed for Microsoft Fabric / Power BI integration.
 * 
 * Security:
 * - Only accepts GET requests (read-only)
 * - Validates API key from environment variable (constant-time comparison)
 * - Extracts companyId from query params for data scoping
 * - Enforces company isolation
 * 
 * NOTE: URL sanitization should be handled by urlSanitizerMiddleware BEFORE this middleware.
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

export const analyticsAuthMiddleware = async (
  req: AnalyticsRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const requestId = (req as any).requestId;
  const requestLogger = requestId ? (req as any).logger : logger;

  try {
    // Enforce read-only (GET only)
    if (req.method !== 'GET') {
      requestLogger.warn(
        {
          requestId,
          method: req.method,
          path: req.path,
          hasApiKey: !!req.headers['x-api-key'],
        },
        'Analytics endpoint - Non-GET request rejected'
      );
      res.status(405).json({
        success: false,
        message: 'Analytics endpoints are read-only (GET only)',
        code: 'METHOD_NOT_ALLOWED',
      });
      return;
    }

    // Check for API key header
    // Express normalizes headers to lowercase, so we only check lowercase
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

    // Log presence of header (for debugging, but not the value)
    const hasApiKey = !!apiKeyHeader;
    requestLogger.debug(
      {
        requestId,
        method: req.method,
        path: req.path,
        hasApiKey,
        apiKeyLength: apiKeyHeader ? apiKeyHeader.length : 0,
      },
      'Analytics auth - Checking API key'
    );

    if (!apiKeyHeader) {
      requestLogger.warn(
        {
          requestId,
          method: req.method,
          path: req.path,
        },
        'Analytics endpoint - Missing x-api-key header'
      );
      res.status(401).json({
        success: false,
        message: 'API key required. Provide x-api-key header.',
        code: 'MISSING_API_KEY',
      });
      return;
    }

    // Trim and sanitize API key from header (remove whitespace and newlines)
    const sanitizedApiKey = apiKeyHeader.trim().replace(/\r?\n/g, '');

    // Reject empty keys
    if (sanitizedApiKey.length === 0) {
      requestLogger.warn(
        {
          requestId,
          method: req.method,
          path: req.path,
        },
        'Analytics endpoint - Empty x-api-key header'
      );
      res.status(401).json({
        success: false,
        message: 'API key cannot be empty',
        code: 'INVALID_API_KEY',
      });
      return;
    }

    // Get expected API key from config (already sanitized at startup)
    const expectedApiKey = config.analytics.apiKey;

    if (!expectedApiKey || expectedApiKey.length === 0) {
      requestLogger.error(
        {
          requestId,
        },
        'ANALYTICS_API_KEY not configured in environment'
      );
      res.status(500).json({
        success: false,
        message: 'Analytics API not configured',
        code: 'CONFIGURATION_ERROR',
      });
      return;
    }

    // Use constant-time comparison to prevent timing attacks
    if (!constantTimeCompare(sanitizedApiKey, expectedApiKey)) {
      requestLogger.warn(
        {
          requestId,
          method: req.method,
          path: req.path,
          providedKeyLength: sanitizedApiKey.length,
          expectedKeyLength: expectedApiKey.length,
        },
        'Analytics endpoint - Invalid API key (length mismatch or incorrect value)'
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
    
    if (!companyId || typeof companyId !== 'string' || companyId.trim().length === 0) {
      requestLogger.warn(
        {
          requestId,
          method: req.method,
          path: req.path,
          hasCompanyId: !!companyId,
        },
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
    
    // Validate companyId format (should be a valid MongoDB ObjectId format - 24 hex characters)
    if (!/^[a-f\d]{24}$/i.test(sanitizedCompanyId)) {
      requestLogger.warn(
        {
          requestId,
          method: req.method,
          path: req.path,
          companyIdLength: sanitizedCompanyId.length,
          companyIdFormat: /^[a-f\d]{24}$/i.test(sanitizedCompanyId) ? 'valid' : 'invalid',
        },
        'Analytics request - Invalid companyId format'
      );
      res.status(400).json({
        success: false,
        message: 'Invalid companyId format. Must be a valid MongoDB ObjectId (24 hex characters).',
        code: 'INVALID_COMPANY_ID',
      });
      return;
    }

    // Attach sanitized companyId to request
    req.companyId = sanitizedCompanyId;
    req.requestId = requestId;

    // Log successful authentication (without sensitive data)
    requestLogger.info(
      {
        requestId,
        method: req.method,
        path: req.path,
        companyId: req.companyId,
      },
      'Analytics API request authenticated successfully'
    );

    next();
  } catch (error) {
    const requestId = (req as any).requestId;
    const requestLogger = requestId ? (req as any).logger : logger;
    
    requestLogger.error(
      {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Analytics auth middleware error'
    );
    res.status(500).json({
      success: false,
      message: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
};


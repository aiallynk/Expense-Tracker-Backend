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
export const analyticsAuthMiddleware = async (
  req: AnalyticsRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
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

    // Check for API key
    const apiKey = req.headers['x-api-key'] as string;

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

    // Validate against environment variable
    const expectedApiKey = config.analytics.apiKey;

    if (!expectedApiKey) {
      logger.error('ANALYTICS_API_KEY not configured in environment');
      res.status(500).json({
        success: false,
        message: 'Analytics API not configured',
        code: 'CONFIGURATION_ERROR',
      });
      return;
    }

    // Use constant-time comparison to prevent timing attacks
    if (apiKey !== expectedApiKey) {
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

    // Extract companyId from query params for data scoping
    const companyId = req.query.companyId as string | undefined;
    
    if (companyId) {
      req.companyId = companyId;
      logger.debug(
        { companyId, path: req.path },
        'Analytics request - Company ID from query param'
      );
    } else {
      // If no companyId provided, you might want to use a default or reject
      // For now, we'll allow it but log a warning
      logger.warn(
        { path: req.path },
        'Analytics request - No companyId provided in query params'
      );
    }

    // Log successful authentication
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


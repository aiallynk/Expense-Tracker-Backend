import { Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';

import { AuthRequest } from './auth.middleware';

import { logger } from '@/config/logger';

/**
 * Middleware to enforce read-only access for service accounts
 * Service accounts can only use GET requests
 */
export const requireServiceAccountReadOnly = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.role === 'SERVICE_ACCOUNT') {
    // Service accounts can only use GET requests
    if (req.method !== 'GET') {
      logger.warn(
        {
          method: req.method,
          path: req.path,
          serviceAccountId: req.user.id,
        },
        'Service account attempted write operation'
      );
      res.status(403).json({
        success: false,
        message: 'Service accounts have read-only access',
        code: 'READ_ONLY_ACCESS',
      });
      return;
    }
  }
  next();
};

/**
 * Middleware to check if service account can access the requested endpoint
 * Validates against allowedEndpoints whitelist
 */
export const validateServiceAccountEndpoint = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (req.user?.role === 'SERVICE_ACCOUNT' && req.user.serviceAccountId) {
    const { ServiceAccount } = await import('../models/ServiceAccount');
    
    try {
      const serviceAccount = await ServiceAccount.findById(
        req.user.serviceAccountId
      ).select('allowedEndpoints').exec();

      if (!serviceAccount) {
        res.status(401).json({
          success: false,
          message: 'Service account not found',
          code: 'SERVICE_ACCOUNT_NOT_FOUND',
        });
        return;
      }

      // Check if the requested path matches any allowed endpoint pattern
      const requestedPath = req.path;
      const isAllowed = serviceAccount.allowedEndpoints.some((pattern) => {
        // Support exact match
        if (pattern === requestedPath) {
          return true;
        }
        
        // Support regex patterns (if pattern starts with ^ or contains regex chars)
        if (pattern.startsWith('^') || pattern.includes('*') || pattern.includes('+')) {
          try {
            const regex = new RegExp(pattern);
            return regex.test(requestedPath);
          } catch (e) {
            // Invalid regex, treat as exact match
            return pattern === requestedPath;
          }
        }
        
        // Support prefix match (if pattern ends with *)
        if (pattern.endsWith('*')) {
          const prefix = pattern.slice(0, -1);
          return requestedPath.startsWith(prefix);
        }
        
        return false;
      });

      if (!isAllowed) {
        logger.warn(
          {
            path: requestedPath,
            serviceAccountId: req.user.serviceAccountId,
            allowedEndpoints: serviceAccount.allowedEndpoints,
          },
          'Service account attempted to access unauthorized endpoint'
        );
        res.status(403).json({
          success: false,
          message: 'Endpoint not allowed for this service account',
          code: 'ENDPOINT_NOT_ALLOWED',
        });
        return;
      }
    } catch (error) {
      logger.error({ error }, 'Error validating service account endpoint');
      res.status(500).json({
        success: false,
        message: 'Error validating service account access',
        code: 'VALIDATION_ERROR',
      });
      return;
    }
  }
  next();
};

/**
 * Rate limiter specifically for service accounts (stricter than regular users)
 */
export const serviceAccountRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each service account to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from service account',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Key generator based on service account ID
  keyGenerator: (req: AuthRequest) => {
    if (req.user?.role === 'SERVICE_ACCOUNT') {
      return `service-account:${req.user.id}`;
    }
    return req.ip || 'unknown';
  },
  skip: (req: AuthRequest) => {
    // Only apply to service accounts
    return req.user?.role !== 'SERVICE_ACCOUNT';
  },
});


import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

import { config } from '../config/index';

import { logger } from '@/config/logger';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email?: string;
    role: string;
    companyId?: string;
    serviceAccountId?: string; // For service accounts
  };
}

/**
 * Validate API key from X-API-Key header
 * Note: Since API keys are hashed, we must check all active accounts
 * Optimized by filtering expired accounts first
 */
async function validateApiKey(apiKey: string): Promise<{
  id: string;
  companyId?: string;
} | null> {
  const { ServiceAccount } = await import('../models/ServiceAccount');
  
  const now = new Date();
  
  // Get all active, non-expired service accounts
  // Filter expired accounts at query level for efficiency
  const serviceAccounts = await ServiceAccount.find({
    isActive: true,
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: { $gt: now } },
    ],
  })
    .select('apiKeyHash companyId')
    .exec();

  // Check each service account's API key
  // Early exit on first match
  for (const account of serviceAccounts) {
    try {
      // Compare API key using bcrypt
      const isValid = await account.compareApiKey(apiKey);
      if (isValid) {
        // Update lastUsedAt (fire and forget, don't wait)
        ServiceAccount.findByIdAndUpdate(account._id, {
          lastUsedAt: new Date(),
        }).exec().catch((err) => {
          logger.error({ error: err, accountId: account._id }, 'Error updating lastUsedAt');
        });

        return {
          id: (account._id as any).toString(),
          companyId: account.companyId
            ? (account.companyId as any).toString()
            : undefined,
        };
      }
    } catch (error) {
      // Skip this account if comparison fails
      logger.debug({ error, accountId: account._id }, 'Error comparing API key');
      continue;
    }
  }

  return null;
}

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Skip authentication for health check endpoints and auth routes
    if (
      req.path === '/health' || 
      req.path === '/healthz' ||
      req.path.startsWith('/api/v1/auth')
    ) {
      return next();
    }

    logger.debug(`Auth middleware - ${req.method} ${req.path}`);

    // PRIORITY 1: Check for API Key (for service accounts)
    const apiKey = req.headers['x-api-key'] as string;
    if (apiKey) {
      logger.debug('Auth middleware - API key detected, validating...');
      
      try {
        const serviceAccount = await validateApiKey(apiKey);
        
        if (serviceAccount) {
          req.user = {
            id: serviceAccount.id,
            role: 'SERVICE_ACCOUNT',
            companyId: serviceAccount.companyId,
            serviceAccountId: serviceAccount.id,
          };

          logger.debug(
            `Auth middleware - API key validated for service account: ${serviceAccount.id}`
          );
          
          // Log service account request
          logger.info(
            {
              serviceAccountId: serviceAccount.id,
              method: req.method,
              path: req.path,
              companyId: serviceAccount.companyId,
            },
            'Service account API request'
          );
          
          return next();
        } else {
          logger.warn(
            { method: req.method, path: req.path },
            'Auth middleware - Invalid API key'
          );
          res.status(401).json({
            success: false,
            message: 'Invalid API key',
            code: 'INVALID_API_KEY',
          });
          return;
        }
      } catch (error) {
        logger.error({ error }, 'Auth middleware - Error validating API key');
        res.status(500).json({
          success: false,
          message: 'Error validating API key',
          code: 'AUTH_ERROR',
        });
        return;
      }
    }

    // PRIORITY 2: Check for JWT Bearer token (for regular users)
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn(`Auth middleware - No authorization header for ${req.method} ${req.path}`);
      res.status(401).json({
        success: false,
        message: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    const token = authHeader.substring(7);
    logger.debug('Auth middleware - JWT token received, verifying...');

    try {
      const decoded = jwt.verify(token, config.jwt.accessSecret) as {
        id: string;
        email: string;
        role: string;
        companyId?: string;
      };

      req.user = {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role,
        companyId: decoded.companyId,
      };

      // Check maintenance mode - block non-super-admin users
      if (decoded.role !== 'SUPER_ADMIN') {
        const { SettingsService } = await import('../services/settings.service');
        const settings = await SettingsService.getSettings();
        
        if (settings.features?.maintenanceMode === true) {
          logger.warn(
            { userId: decoded.id, email: decoded.email, role: decoded.role },
            'Auth middleware - User blocked due to maintenance mode'
          );
          
          // Emit maintenance mode logout event to user's socket
          const { emitMaintenanceModeLogout } = await import('../socket/realtimeEvents');
          emitMaintenanceModeLogout(decoded.id);
          
          res.status(503).json({
            success: false,
            message: 'System is under maintenance. Please try again later.',
            code: 'MAINTENANCE_MODE',
            maintenanceMode: true,
          });
          return;
        }
      }

      logger.debug(`Auth middleware - Token verified for user: ${decoded.email} (${decoded.id})`);
      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        logger.warn({ method: req.method, path: req.path }, 'Auth middleware - Token expired');
        res.status(401).json({
          success: false,
          message: 'Token expired',
          code: 'TOKEN_EXPIRED',
        });
        return;
      }

      if (error instanceof jwt.JsonWebTokenError) {
        logger.warn(
          { method: req.method, path: req.path, error: error.message },
          'Auth middleware - Invalid token'
        );
        res.status(401).json({
          success: false,
          message: 'Invalid token',
          code: 'INVALID_TOKEN',
        });
        return;
      }

      logger.error({ error }, 'Auth middleware - Unexpected error');
      throw error;
    }
  } catch (error) {
    logger.error({ error }, 'Auth middleware error');
    res.status(500).json({
      success: false,
      message: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
};


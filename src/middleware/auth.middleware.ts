import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

import { config } from '../config/index';

import { logger } from '@/config/logger';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    companyId?: string;
  };
}

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Skip authentication for health check endpoints
    if (req.path === '/health' || req.path === '/healthz') {
      return next();
    }

    logger.debug(`Auth middleware - ${req.method} ${req.path}`);
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
    logger.debug('Auth middleware - Token received, verifying...');

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


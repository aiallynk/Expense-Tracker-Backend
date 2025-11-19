import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index';
import { logger } from '../utils/logger';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
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
      };

      req.user = {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role,
      };

      logger.debug(`Auth middleware - Token verified for user: ${decoded.email} (${decoded.id})`);
      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        logger.warn(`Auth middleware - Token expired for ${req.method} ${req.path}`);
        res.status(401).json({
          success: false,
          message: 'Token expired',
          code: 'TOKEN_EXPIRED',
        });
        return;
      }

      if (error instanceof jwt.JsonWebTokenError) {
        logger.warn(`Auth middleware - Invalid token for ${req.method} ${req.path}:`, error.message);
        res.status(401).json({
          success: false,
          message: 'Invalid token',
          code: 'INVALID_TOKEN',
        });
        return;
      }

      logger.error('Auth middleware - Unexpected error:', error);
      throw error;
    }
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
};


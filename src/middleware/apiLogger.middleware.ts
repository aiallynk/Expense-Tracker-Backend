import { Request, Response, NextFunction } from 'express';

import { ApiRequestLog } from '../models/ApiRequestLog';
import { emitLogEntry } from '../socket/realtimeEvents';

import { logger } from '@/config/logger';
import { AuthRequest } from './auth.middleware';

/**
 * Middleware to log API requests for analytics
 * Tracks: method, path, status code, response time, user, IP
 */
export const apiLoggerMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const startTime = Date.now();
  const originalSend = res.send;

  // Override res.send to capture response time
  res.send = function (body: any) {
    const responseTime = Date.now() - startTime;
    
    // Log asynchronously (don't block response)
    setImmediate(async () => {
      try {
        const authReq = req as AuthRequest;
        const logEntry = await ApiRequestLog.create({
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          responseTime,
          userId: authReq.user?.id ? (authReq.user.id as any) : undefined,
          ipAddress: req.ip || req.socket.remoteAddress,
          userAgent: req.get('user-agent'),
        });

        // Emit real-time log events for errors and security issues
        if (res.statusCode >= 400) {
          // Error log (4xx or 5xx)
          const errorType = res.statusCode >= 500 ? 'Backend Error' : 'Client Error';
          const description = `${req.method} ${req.path} returned ${res.statusCode}`;
          
          // Format timestamp to IST
          const date = new Date();
          const istOffset = 5.5 * 60 * 60 * 1000;
          const utcTime = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
          const istTime = new Date(utcTime + istOffset);
          const year = istTime.getFullYear();
          const month = String(istTime.getMonth() + 1).padStart(2, '0');
          const day = String(istTime.getDate()).padStart(2, '0');
          const hours = String(istTime.getHours()).padStart(2, '0');
          const minutes = String(istTime.getMinutes()).padStart(2, '0');
          const seconds = String(istTime.getSeconds()).padStart(2, '0');
          const istTimestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

          emitLogEntry({
            type: 'error',
            id: (logEntry._id as any).toString(),
            timestamp: istTimestamp,
            user: (authReq.user as any)?.email || 'Unknown',
            company: (authReq.user as any)?.name || 'System',
            errorType,
            description,
            details: {
              endpoint: req.path,
              method: req.method,
              statusCode: res.statusCode,
              responseTime,
              ipAddress: req.ip || req.socket.remoteAddress,
            },
          });
        }

        // Security log (failed logins, rate limits)
        if (res.statusCode === 429 || (req.path.includes('/auth/login') && res.statusCode >= 400)) {
          let eventType = 'Security Event';
          let description = 'Security event detected';

          if (res.statusCode === 429) {
            eventType = 'Rate Limit Exceeded';
            description = `Rate limit exceeded for ${req.path}`;
          } else if (req.path.includes('/auth/login') && res.statusCode >= 400) {
            eventType = 'Failed Login Attempt';
            description = `Failed login attempt${(authReq.user as any)?.email ? ` for ${(authReq.user as any).email}` : ''}`;
          }

          // Format timestamp to IST
          const date = new Date();
          const istOffset = 5.5 * 60 * 60 * 1000;
          const utcTime = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
          const istTime = new Date(utcTime + istOffset);
          const year = istTime.getFullYear();
          const month = String(istTime.getMonth() + 1).padStart(2, '0');
          const day = String(istTime.getDate()).padStart(2, '0');
          const hours = String(istTime.getHours()).padStart(2, '0');
          const minutes = String(istTime.getMinutes()).padStart(2, '0');
          const seconds = String(istTime.getSeconds()).padStart(2, '0');
          const istTimestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

          emitLogEntry({
            type: 'security',
            id: (logEntry._id as any).toString(),
            timestamp: istTimestamp,
            user: (authReq.user as any)?.email || 'Unknown',
            company: (authReq.user as any)?.name || 'System',
            eventType,
            description,
            details: {
              endpoint: req.path,
              method: req.method,
              statusCode: res.statusCode,
              ipAddress: req.ip || req.socket.remoteAddress,
              userAgent: req.get('user-agent'),
            },
          });
        }
      } catch (error) {
        // Don't fail request if logging fails - use logger if available
        // Only log in non-production to prevent spam
        if (process.env.NODE_ENV !== 'production') {
          logger.error({ error }, 'Failed to log API request');
        }
      }
    });

    return originalSend.call(this, body);
  };

  next();
};


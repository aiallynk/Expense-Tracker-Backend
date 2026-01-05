import { Request, Response, NextFunction } from 'express';
import { logger } from '@/config/logger';

/**
 * URL Sanitization Middleware
 * 
 * Fixes issues where Microsoft Fabric / Power BI sends URLs with %0A (newline) characters.
 * This middleware sanitizes the URL BEFORE route matching to prevent path injection attacks.
 * 
 * Must be registered early in the middleware chain, after requestId but before routes.
 */
export const urlSanitizerMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const requestId = (req as any).requestId;
  const requestLogger = requestId ? (req as any).logger : logger;

  try {
    // Get original URL and path
    const originalUrl = req.originalUrl || req.url || '';
    const originalPath = req.path || '';

    // Sanitize: remove newlines, carriage returns, and URL-encoded versions
    const sanitizedUrl = originalUrl
      .replace(/%0A/gi, '') // Remove URL-encoded newline (%0A)
      .replace(/%0D/gi, '') // Remove URL-encoded carriage return (%0D)
      .replace(/\r/g, '')   // Remove literal \r
      .replace(/\n/g, '');  // Remove literal \n

    const sanitizedPath = originalPath
      .replace(/%0A/gi, '')
      .replace(/%0D/gi, '')
      .replace(/\r/g, '')
      .replace(/\n/g, '');

    // Check if sanitization changed anything
    if (sanitizedUrl !== originalUrl || sanitizedPath !== originalPath) {
      requestLogger.warn(
        {
          originalUrl,
          sanitizedUrl,
          originalPath,
          sanitizedPath,
          method: req.method,
        },
        'URL sanitization detected and removed newline characters'
      );

      // Update request object with sanitized values
      // Note: req.url and req.path are read-only, but we can modify req.originalUrl
      // Express will use the sanitized path for routing
      (req as any).originalUrl = sanitizedUrl;
      (req as any).path = sanitizedPath;
      
      // If URL was malformed, reject with 400
      if (sanitizedUrl.length === 0 || sanitizedPath.length === 0) {
        res.status(400).json({
          success: false,
          message: 'Invalid URL format: URL contains invalid characters',
          code: 'INVALID_URL_FORMAT',
        });
        return;
      }
    }

    next();
  } catch (error) {
    requestLogger.error({ error }, 'URL sanitization middleware error');
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};


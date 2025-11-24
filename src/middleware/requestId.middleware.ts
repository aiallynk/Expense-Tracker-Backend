import { randomUUID } from 'crypto';

import { Request, Response, NextFunction } from 'express';

import { config } from '../config/index';
import { createRequestLogger } from '../config/logger';

/**
 * Request ID middleware
 * - Extracts X-Request-ID from header or generates a new UUID
 * - Attaches requestId to request object and response headers
 * - Creates a request-scoped logger with requestId in context
 */
export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const headerName = process.env.REQUEST_ID_HEADER || config.app.env === 'development' ? 'X-Request-ID' : 'X-Request-ID';
  const requestId = (req.headers[headerName.toLowerCase()] as string) || randomUUID();

  // Attach to request for use in controllers/services
  (req as any).requestId = requestId;
  (req as any).logger = createRequestLogger(requestId);

  // Add to response headers for client correlation
  res.setHeader(headerName, requestId);

  next();
};


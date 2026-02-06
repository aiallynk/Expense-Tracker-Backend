import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';

import { logger } from '@/config/logger';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

export const errorMiddleware = (
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const requestId = (req as any).requestId;
  const requestLogger = requestId ? (req as any).logger : logger;

  // Log error with request context
  requestLogger.error(
    {
      error: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      statusCode: err.statusCode || 500,
      code: err.code,
      requestId,
    },
    'Request error'
  );

  // Mongoose validation error
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      success: false,
      message: 'Validation error',
      code: 'VALIDATION_ERROR',
      details: Object.values(err.errors).map((e) => ({
        path: e.path,
        message: e.message,
      })),
    });
    return;
  }

  // Mongoose cast error (invalid ObjectId)
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({
      success: false,
      message: 'Invalid ID format',
      code: 'INVALID_ID',
    });
    return;
  }

  // MongoDB duplicate key (E11000) - entity-appropriate messages for cost centres, projects, categories
  const errAny = err as AppError & { code?: number };
  if (errAny.code === 11000) {
    const msg = (err.message ?? '').toLowerCase();
    const entity =
      msg.includes('costcentres') ? 'cost centre' :
      msg.includes('categories') ? 'category' :
      msg.includes('projects') ? 'project' :
      'record';
    const isName = msg.includes('companyId_1_name_1');
    const isCode = msg.includes('companyId_1_code_1') || msg.includes('code_1');
    const duplicateMessage =
      isName ? `A ${entity} with this name already exists for your company.` :
      isCode ? `A ${entity} with this code already exists for your company.` :
      'A record with this value already exists for your company.';
    res.status(400).json({
      success: false,
      message: duplicateMessage,
      code: 'DUPLICATE_KEY',
    });
    return;
  }

  // Custom application error
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';
  const code = err.code || 'INTERNAL_ERROR';

  res.status(statusCode).json({
    success: false,
    message,
    code,
    ...(process.env.APP_ENV === 'development' && { stack: err.stack }),
  });
};

export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};


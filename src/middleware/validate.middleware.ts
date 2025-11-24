import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

import { logger } from '@/config/logger';

export const validate = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      logger.debug({ method: req.method, path: req.path }, 'Validation middleware - Validating');
      logger.debug({ body: req.body }, 'Request body');
      schema.parse(req.body);
      logger.debug('Validation passed');
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const requestId = (req as any).requestId;
        logger.warn(
          {
            requestId,
            method: req.method,
            path: req.path,
            errors: error.errors,
          },
          'Validation failed'
        );
        res.status(400).json({
          success: false,
          message: 'Validation error',
          code: 'VALIDATION_ERROR',
          details: error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
            code: err.code,
          })),
        });
        return;
      }
      logger.error({ error }, 'Validation middleware - Unexpected error');
      next(error);
    }
  };
};

export const validateQuery = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.query = schema.parse(req.query);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          message: 'Query validation error',
          code: 'VALIDATION_ERROR',
          details: error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
};

export const validateParams = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.params = schema.parse(req.params);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          message: 'Parameter validation error',
          code: 'VALIDATION_ERROR',
          details: error.errors.map((err) => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
};


import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';

import { config } from './config/index';
import { redisConnection } from './config/queue';
import { apiLoggerMiddleware } from './middleware/apiLogger.middleware';
import { errorMiddleware } from './middleware/error.middleware';
import { apiRateLimiter } from './middleware/rateLimit.middleware';
import { requestIdMiddleware } from './middleware/requestId.middleware';
import adminRoutes from './routes/admin.routes';
import accountantRoutes from './routes/accountant.routes';
import authRoutes from './routes/auth.routes';
import bulkUploadRoutes from './routes/bulkUpload.routes';
import businessHeadRoutes from './routes/businessHead.routes';
import categoriesRoutes from './routes/categories.routes';
import costCentresRoutes from './routes/costCentres.routes';
import companyAdminRoutes from './routes/companyAdmin.routes';
import companySettingsRoutes from './routes/companySettings.routes';
import departmentsRoutes from './routes/departments.routes';
import expensesRoutes from './routes/expenses.routes';
import managerRoutes from './routes/manager.routes';
import notificationsRoutes from './routes/notifications.routes';
import ocrRoutes from './routes/ocr.routes';
import projectsRoutes from './routes/projects.routes';
import receiptsRoutes from './routes/receipts.routes';
import reportsRoutes from './routes/reports.routes';
import serviceAccountRoutes from './routes/serviceAccount.routes';
import superAdminRoutes from './routes/superAdmin.routes';
import usersRoutes from './routes/users.routes';
import analyticsRoutes from './routes/analytics.routes';
import currencyRoutes from './routes/currency.routes';

import { logger } from '@/config/logger';

export const createApp = (): Express => {
  const app = express();

  // Trust proxy - Required for Render and other reverse proxies
  // Trust only the first proxy (Render's load balancer) for security
  // This allows Express to correctly identify client IPs and handle X-Forwarded-* headers
  // Setting to 1 (instead of true) only trusts the first proxy, preventing IP spoofing
  app.set('trust proxy', 1);

  // Request ID middleware (must be first to add requestId to all requests)
  app.use(requestIdMiddleware);

  // Security middleware
  if (config.app.env === 'development') {
    // Relaxed security in development
    app.use(
      helmet({
        contentSecurityPolicy: false, // Disable CSP in development
        crossOriginEmbedderPolicy: false,
      })
    );
  } else {
    // Production security
    app.use(helmet());
  }

  // CORS configuration
  if (config.app.env === 'development') {
    // In development, allow all origins for easier testing
    app.use(
      cors({
        origin: true, // Allow all origins in development
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'x-api-key'],
      })
    );
  } else {
    // In production, use specific origins
    const allowedOrigins = [
      config.app.frontendUrlApp,
      config.app.frontendUrlAdmin,
    ].filter(Boolean); // Remove undefined values

    if (allowedOrigins.length === 0) {
      logger.warn('No frontend URLs configured for CORS in production');
    }

    app.use(
      cors({
        origin: (origin, callback) => {
          // Allow requests with no origin (mobile apps, Postman, etc.)
          if (!origin) {
            return callback(null, true);
          }
          if (allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            logger.warn({ origin }, 'CORS blocked origin');
            callback(new Error('Not allowed by CORS'));
          }
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'x-api-key'],
      })
    );
  }

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Rate limiting
  app.use('/api/v1', apiRateLimiter);

  // API request logging (for analytics) - after rate limiting but before routes
  app.use('/api/v1', apiLoggerMiddleware);

  // Analytics routes (read-only, API key only, no JWT required)
  // Must be registered BEFORE auth middleware to bypass JWT requirement
  app.use('/api/v1/analytics', analyticsRoutes);

  // Health check endpoint (legacy)
  app.get('/health', (_req, res) => {
    const isDbConnected = mongoose.connection.readyState === 1;

    res.status(200).json({
      success: true,
      message: 'Server is healthy',
      timestamp: new Date().toISOString(),
      database: {
        connected: isDbConnected,
        status: isDbConnected ? 'connected' : 'disconnected',
      },
    });
  });

  // Health check endpoint with DB and Redis status (Render-compatible)
  app.get('/healthz', async (_req, res) => {
    const isDbConnected = mongoose.connection.readyState === 1;
    let isRedisConnected = false;

    try {
      // Check Redis connection (if available)
      // Redis is optional - only needed for OCR queue/worker
      if (redisConnection) {
        const redisStatus = await redisConnection.ping();
        isRedisConnected = redisStatus === 'PONG';
      }
    } catch (error) {
      logger.debug({ error }, 'Redis health check failed');
      isRedisConnected = false;
    }

    // Server is healthy if DB is connected
    // Redis is optional (only needed for OCR queue/worker)
    const isHealthy = isDbConnected;

    res.status(isHealthy ? 200 : 503).json({
      success: isHealthy,
      message: isHealthy ? 'Server is healthy' : 'Server is unhealthy',
      timestamp: new Date().toISOString(),
      database: {
        connected: isDbConnected,
        status: isDbConnected ? 'connected' : 'disconnected',
      },
      redis: {
        connected: isRedisConnected,
        status: isRedisConnected ? 'connected' : 'disconnected',
      },
    });
  });

  // API routes
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', usersRoutes);
  app.use('/api/v1/projects', projectsRoutes);
  app.use('/api/v1/categories', categoriesRoutes);
  app.use('/api/v1/cost-centres', costCentresRoutes);
  app.use('/api/v1/reports', reportsRoutes);
  app.use('/api/v1', expensesRoutes);
  app.use('/api/v1', receiptsRoutes);
  app.use('/api/v1', bulkUploadRoutes);
  app.use('/api/v1/ocr', ocrRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/super-admin', superAdminRoutes);
  app.use('/api/v1/companies', companyAdminRoutes);
  app.use('/api/v1/company-admin', companySettingsRoutes);
  app.use('/api/v1/departments', departmentsRoutes);
  app.use('/api/v1/notifications', notificationsRoutes);
  app.use('/api/v1/service-accounts', serviceAccountRoutes);

  // Manager routes
  app.use('/api/v1/manager', managerRoutes);

  // Business Head routes
  app.use('/api/v1/business-head', businessHeadRoutes);

  // Accountant routes
  app.use('/api/v1/accountant', accountantRoutes);

  // Currency routes
  app.use('/api/v1/currency', currencyRoutes);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      message: 'Route not found',
      code: 'NOT_FOUND',
    });
  });

  // Error handling middleware (must be last)
  app.use(errorMiddleware);

  return app;
};

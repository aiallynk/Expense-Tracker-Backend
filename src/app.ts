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
import { urlSanitizerMiddleware } from './middleware/urlSanitizer.middleware';
import appRoutes from './routes/app.routes';
import accountantRoutes from './routes/accountant.routes';
import adminRoutes from './routes/admin.routes';
import advanceCashRoutes from './routes/advanceCash.routes';
import analyticsRoutes from './routes/analytics.routes';
import voucherRoutes from './routes/voucher.routes';
import voucherReturnRoutes from './routes/voucherReturn.routes';
import approvalMatrixRoutes from './routes/approvalMatrix.routes';
import authRoutes from './routes/auth.routes';
import bulkUploadRoutes from './routes/bulkUpload.routes';
import businessHeadRoutes from './routes/businessHead.routes';
import categoriesRoutes from './routes/categories.routes';
import companyAdminRoutes from './routes/companyAdmin.routes';
import companySettingsRoutes from './routes/companySettings.routes';
import costCentresRoutes from './routes/costCentres.routes';
import currencyRoutes from './routes/currency.routes';
import departmentsRoutes from './routes/departments.routes';
import employeeApprovalProfilesRoutes from './routes/employeeApprovalProfiles.routes';
import expensesRoutes from './routes/expenses.routes';
import managerRoutes from './routes/manager.routes';
import metaRoutes from './routes/meta.routes';
import notificationsRoutes from './routes/notifications.routes';
import ingestRoutes from './routes/ingest.routes';
import ocrRoutes from './routes/ocr.routes';
import projectsRoutes from './routes/projects.routes';
import projectStakeholderRoutes from './routes/projectStakeholder.routes';
import receiptsRoutes from './routes/receipts.routes';
import reportsRoutes from './routes/reports.routes';
import serviceAccountRoutes from './routes/serviceAccount.routes';
import superAdminRoutes from './routes/superAdmin.routes';
import usersRoutes from './routes/users.routes';

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

  // URL sanitization middleware (fixes %0A bug from Microsoft Fabric / Power BI)
  // Must be early in chain, before routes, to sanitize URLs before route matching
  app.use(urlSanitizerMiddleware);

  // Security middleware
  if (config.app.env === 'development') {
    // Relaxed security in development - allow CORS
    app.use(
      helmet({
        contentSecurityPolicy: false, // Disable CSP in development
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow cross-origin requests
      })
    );
  } else {
    // Production security
    app.use(
      helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow cross-origin requests
      })
    );
  }

  // CORS configuration - MUST be before routes
  // Always allow CORS in development, check environment properly
  const isDevelopment = config.app.env === 'development' || 
                        process.env.NODE_ENV === 'development' || 
                        process.env.NODE_ENV !== 'production';
  
  // Log CORS configuration for debugging
  logger.info({ 
    env: config.app.env, 
    nodeEnv: process.env.NODE_ENV,
    isDevelopment,
    port: config.app.port
  }, 'CORS Configuration');
  
  if (isDevelopment) {
    // In development, allow all origins for easier testing
    logger.info('CORS: Development mode - allowing all origins (including localhost:5173)');
    
    // Use simple CORS configuration that definitely works
    // Apply CORS middleware globally
    app.use(cors({
      origin: true, // Allow all origins in development
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'x-api-key', 'Accept'],
      exposedHeaders: ['Content-Type', 'Authorization'],
      preflightContinue: false,
      optionsSuccessStatus: 204,
      maxAge: 86400, // 24 hours
    }));
  } else {
    // In production, use specific origins
    const allowedOrigins = [
      config.app.frontendUrlApp,
      config.app.frontendUrlAdmin,
    ].filter(Boolean); // Remove undefined values

    if (allowedOrigins.length === 0) {
      logger.warn('No frontend URLs configured for CORS in production');
    }

    logger.info({ allowedOrigins }, 'CORS: Production mode - using configured origins');
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
            logger.warn({ origin, allowedOrigins }, 'CORS blocked origin');
            callback(new Error('Not allowed by CORS'));
          }
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'x-api-key', 'Accept'],
        exposedHeaders: ['Content-Type', 'Authorization'],
        preflightContinue: false,
        optionsSuccessStatus: 204,
        maxAge: 86400,
      })
    );
  }

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Rate limiting (skip OPTIONS requests for CORS preflight)
  app.use('/api/v1', (req, res, next) => {
    if (req.method === 'OPTIONS') {
      return next(); // Skip rate limiting for OPTIONS requests
    }
    return apiRateLimiter(req, res, next);
  });

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
  app.use('/api/v1/project-stakeholders', projectStakeholderRoutes);
  app.use('/api/v1/categories', categoriesRoutes);
  app.use('/api/v1/cost-centres', costCentresRoutes);
  app.use('/api/v1/advance-cash', advanceCashRoutes);
  app.use('/api/v1/vouchers', voucherRoutes);
  app.use('/api/v1/voucher-returns', voucherReturnRoutes);
  app.use('/api/v1/reports', reportsRoutes);
  app.use('/api/v1', expensesRoutes);
  app.use('/api/v1', receiptsRoutes);
  app.use('/api/v1', bulkUploadRoutes);
  app.use('/api/v1/ingest', ingestRoutes);
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

  // Approval Matrix routes
  app.use('/api/v1/approval-matrix', approvalMatrixRoutes);

  // Employee Approval Profiles (AI-generated + manual override chains)
  app.use('/api/v1/employee-approval-profiles', employeeApprovalProfilesRoutes);

  // Meta routes (version info, etc.) - public endpoints
  app.use('/api/meta', metaRoutes);

  // App routes (in-app APK update, etc.) - public endpoints
  app.use('/api/app', appRoutes);

  // Test routes (for debugging - remove in production or add auth)
  if (config.app.env === 'development') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testEmailRoutes = require('./routes/test-email.routes').default;
    app.use('/api/v1', testEmailRoutes);
  }

  // Diagnostic routes (admin only - available in all environments)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const diagnoseEmailNotificationsRoutes = require('./routes/diagnose-email-notifications.routes').default;
  app.use('/api/v1/diagnose', diagnoseEmailNotificationsRoutes);

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

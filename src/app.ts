import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index';
import { errorMiddleware } from './middleware/error.middleware';
import { apiRateLimiter } from './middleware/rateLimit.middleware';
import { logger } from './utils/logger';

// Routes
import authRoutes from './routes/auth.routes';
import usersRoutes from './routes/users.routes';
import projectsRoutes from './routes/projects.routes';
import categoriesRoutes from './routes/categories.routes';
import reportsRoutes from './routes/reports.routes';
import expensesRoutes from './routes/expenses.routes';
import receiptsRoutes from './routes/receipts.routes';
import ocrRoutes from './routes/ocr.routes';
import adminRoutes from './routes/admin.routes';
import notificationsRoutes from './routes/notifications.routes';

export const createApp = (): Express => {
  const app = express();

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
        allowedHeaders: ['Content-Type', 'Authorization'],
      })
    );
  } else {
    // In production, use specific origins
    app.use(
      cors({
        origin: [
          config.app.frontendUrlApp,
          config.app.frontendUrlAdmin,
        ],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
      })
    );
  }

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Rate limiting
  app.use('/api/v1', apiRateLimiter);

  // Health check
  app.get('/health', (req, res) => {
    res.status(200).json({
      success: true,
      message: 'Server is healthy',
      timestamp: new Date().toISOString(),
    });
  });

  // API routes
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', usersRoutes);
  app.use('/api/v1/projects', projectsRoutes);
  app.use('/api/v1/categories', categoriesRoutes);
  app.use('/api/v1/reports', reportsRoutes);
  app.use('/api/v1', expensesRoutes);
  app.use('/api/v1', receiptsRoutes);
  app.use('/api/v1/ocr', ocrRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/notifications', notificationsRoutes);

  // 404 handler
  app.use((req, res) => {
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


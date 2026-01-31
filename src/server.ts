import { createServer, Server } from 'http';
import os from 'os';

import express from 'express';

import { createApp } from './app';
import { connectDB, disconnectDB } from './config/db';
import { initializeFirebase } from './config/firebase';
import { config } from './config/index';
import { redisConnection , ocrQueue } from './config/queue';
import { CompanyAdminDashboardService } from './services/companyAdminDashboard.service';
import { NotificationBroadcastService } from './services/notificationBroadcast.service';
import { SystemAnalyticsService } from './services/systemAnalytics.service';
import { schedulerService } from './services/scheduler.service';
import { initializeSocketServer } from './socket/socketServer';
import { startExchangeRateWorker } from './worker/exchangeRate.worker';
import { startInProcessOcrWorker, stopInProcessOcrWorker } from './worker/ocr.inProcessWorker';
import { startAnalyticsSnapshotWorker, stopAnalyticsSnapshotWorker } from './worker/analyticsSnapshot.worker';

import { logger } from '@/config/logger';



// Store server reference for graceful shutdown
let httpServer: Server | null = null;

/**
 * Graceful shutdown handler
 * Closes all connections: HTTP server, MongoDB, Redis, BullMQ
 */
const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'Graceful shutdown initiated');

  // Stop accepting new connections
  if (httpServer) {
    httpServer.close(() => {
      logger.info('HTTP server closed');
    });
  }

  // Close MongoDB connection
  try {
    await disconnectDB();
    logger.info('MongoDB disconnected');
  } catch (error) {
    logger.error({ error }, 'Error disconnecting from MongoDB');
  }

  // Close BullMQ queue
  try {
    if (ocrQueue) {
      await ocrQueue.close();
      logger.info('BullMQ queue closed');
    }
  } catch (error) {
    logger.error({ error }, 'Error closing BullMQ queue');
  }

  // Close Redis connection
  try {
    if (redisConnection) {
      await redisConnection.quit();
      logger.info('Redis connection closed');
    }
  } catch (error) {
    logger.error({ error }, 'Error closing Redis connection');
  }

  // Stop scheduler service
  try {
    schedulerService.stop();
    logger.info('Scheduler service stopped');
  } catch (error) {
    logger.error({ error }, 'Error stopping scheduler service');
  }

  // Stop in-process OCR worker
  try {
    await stopInProcessOcrWorker();
    logger.info('In-process OCR worker stopped');
  } catch (error) {
    logger.error({ error }, 'Error stopping in-process OCR worker');
  }

  // Stop analytics snapshot worker
  try {
    stopAnalyticsSnapshotWorker();
    logger.info('Analytics snapshot worker stopped');
  } catch (error) {
    logger.error({ error }, 'Error stopping analytics snapshot worker');
  }

  // Give connections time to close (max 10 seconds)
  setTimeout(() => {
    logger.info('Graceful shutdown complete');
    process.exit(0);
  }, 10000);
};

const startServer = async (): Promise<Server> => {
  try {
    // Render-friendly port binding: PORT (Render) || APP_PORT || 4000
    const PORT = process.env.PORT
      ? parseInt(process.env.PORT, 10)
      : process.env.APP_PORT
      ? parseInt(process.env.APP_PORT, 10)
      : 4000;

    logger.info(
      {
        port: PORT,
        env: config.app.env,
        nodeVersion: process.version,
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      'Starting server'
    );

    // Create Express app
    let app: express.Express;
    try {
      app = createApp();
      logger.info('Express application created successfully');
    } catch (error) {
      logger.error({ error }, 'Error creating app');
      // Create minimal app if createApp fails
      app = express();
      app.get('/health', (_req: any, res: any) => {
        res.json({ status: 'error', message: 'App initialization failed' });
      });
      app.get('/healthz', (_req: any, res: any) => {
        res.json({ status: 'error', message: 'App initialization failed' });
      });
    }

    // Create HTTP server
    httpServer = createServer(app);

    // Initialize Socket.IO server
    initializeSocketServer(httpServer);

    // Start listening - critical for Render port detection
    return new Promise((resolve, reject) => {
      httpServer!.listen(PORT, '0.0.0.0', () => {
        logger.info({ port: PORT }, 'Server listening');

        // Development-only network info
        if (config.app.env === 'development') {
          logger.info({ apiUrl: `http://localhost:${PORT}/api/v1` }, 'API endpoint');
          logger.info({ apiUrl: `http://10.0.2.2:${PORT}/api/v1` }, 'Android emulator endpoint');

          // Get network IP addresses
          const networkInterfaces = os.networkInterfaces();
          const addresses: string[] = [];

          Object.keys(networkInterfaces).forEach((interfaceName) => {
            const interfaces = networkInterfaces[interfaceName];
            if (interfaces) {
              interfaces.forEach((iface: any) => {
                if (iface.family === 'IPv4' && !iface.internal) {
                  addresses.push(iface.address);
                }
              });
            }
          });

          if (addresses.length > 0) {
            addresses.forEach((addr) => {
              logger.info({ apiUrl: `http://${addr}:${PORT}/api/v1` }, 'Physical device endpoint');
            });
          }
        }

        resolve(httpServer!);
      });

      httpServer!.on('error', (error: any) => {
        logger.error({ error, port: PORT }, 'Server error');
        if (error.code === 'EADDRINUSE') {
          logger.fatal({ port: PORT }, 'Port already in use');
        }
        reject(error);
      });
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    throw error;
  }
};

// Initialize services (non-blocking)
const initializeServices = async (): Promise<void> => {
  try {
    // Connect to MongoDB (non-blocking, will retry in background)
    connectDB().catch((err) => {
      logger.warn({ error: err }, 'MongoDB connection failed, will retry in background');
    });

    // Initialize Firebase Admin (optional)
    try {
      initializeFirebase();
      logger.info('Firebase initialized');
    } catch (err) {
      logger.warn({ error: err }, 'Firebase initialization failed, continuing without it');
    }

    // Start periodic system analytics updates (every 30 seconds)
    setInterval(() => {
      SystemAnalyticsService.collectAndEmitAnalytics().catch((err) => {
        logger.error({ error: err }, 'Error in periodic analytics update');
      });
    }, 30000);

    // Start periodic dashboard analytics updates (every 30 seconds)
    setInterval(() => {
      SystemAnalyticsService.collectAndEmitDashboardAnalytics().catch((err) => {
        logger.error({ error: err }, 'Error in periodic dashboard analytics update');
      });
    }, 30000);

    // Start periodic company admin dashboard updates (every 30 seconds)
    setInterval(() => {
      CompanyAdminDashboardService.collectAndEmitDashboardStats().catch((err) => {
        logger.error({ error: err }, 'Error in periodic company admin dashboard update');
      });
    }, 30000);

    // Start exchange rate worker (daily cron job)
    startExchangeRateWorker();

    // Process scheduled notification broadcasts (every 60 seconds)
    setInterval(() => {
      NotificationBroadcastService.processDueScheduled().catch((err) => {
        logger.error({ error: err }, 'Error processing scheduled notification broadcasts');
      });
    }, 60_000);

    // Start SuperAdmin insight detection scheduler
    schedulerService.start();
    logger.info('SuperAdmin insight scheduler started');

    // Start in-process OCR worker (processes queued OCR jobs)
    startInProcessOcrWorker();

    // Start analytics snapshot worker (processes queued analytics events)
    startAnalyticsSnapshotWorker();

    logger.info('Periodic analytics services started');
  } catch (error) {
    logger.warn({ error }, 'Error initializing services');
    // Don't exit - server is already listening
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (error: Error) => {
  // Suppress Redis connection errors in development mode
  if (config.app.env === 'development') {
    const errorCode = (error as any).code;
    const errorMessage = error.message || String(error);
    const errorName = error.name || '';
    
    // Check if it's a Redis connection error (AggregateError with ECONNREFUSED)
    if (
      errorName === 'AggregateError' ||
      errorCode === 'ECONNREFUSED' ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('Redis') ||
      (error as any).errors?.some?.((e: any) => e?.code === 'ECONNREFUSED' || e?.syscall === 'connect')
    ) {
      // Silently ignore Redis connection errors in development
      return;
    }
  }
  
  logger.error({ error }, 'Unhandled promise rejection');
  // In production, we might want to exit, but for now just log
  if (config.app.env === 'production') {
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

// Graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
startServer()
  .then(async (server) => {
    // Store server reference globally for graceful shutdown
    (global as any).httpServer = server;
    logger.info('Server started successfully');
    // Initialize services after server is listening
    await initializeServices();
  })
  .catch((error) => {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  });

// Export server for testing
export { httpServer };

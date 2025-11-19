import { createApp } from './app';
import { connectDB } from './config/db';
import { initializeFirebase } from './config/firebase';
import { config } from './config/index';
import { logger } from './utils/logger';
import { createServer } from 'http';
import express from 'express';
import os from 'os';

const startServer = async (): Promise<void> => {
  try {
    // Get port FIRST - prioritize process.env.PORT for Render compatibility
    // Render requires this to be set from process.env.PORT
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : config.app.port;
    
    // Log port for debugging (Render shows console output)
    console.log(`Starting server on port ${PORT}`);
    console.log(`PORT env var: ${process.env.PORT}`);
    console.log(`Config port: ${config.app.port}`);

    // Create Express app - wrap in try-catch to ensure server starts even if app creation fails
    let app;
    try {
      app = createApp();
    } catch (error) {
      console.error('Error creating app:', error);
      // Create minimal app if createApp fails
      app = express();
      app.get('/health', (_req: any, res: any) => {
        res.json({ status: 'error', message: 'App initialization failed' });
      });
    }

    // Create HTTP server and listen on the specified port IMMEDIATELY
    // This must happen synchronously for Render to detect the port
    const server = createServer(app);
    
    // Start listening immediately - this is critical for Render port detection
    server.listen(PORT, '0.0.0.0', () => {
      // Store server reference for graceful shutdown
      (global as any).httpServer = server;
      
      // Use console.log for Render visibility
      console.log(`Server running on port ${PORT}`);
      logger.info(`Server running on port ${PORT}`);
      
      // Additional info for development only
      if (config.app.env === 'development') {
        logger.info(`Environment: ${config.app.env}`);
        logger.info(`API available at http://localhost:${PORT}/api/v1`);
        logger.info(`For Android emulator, use: http://10.0.2.2:${PORT}/api/v1`);
        
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
          logger.info(`For physical devices, use one of these IPs:`);
          addresses.forEach((addr) => {
            logger.info(`  http://${addr}:${PORT}/api/v1`);
          });
        }
      }
    });

    server.on('error', (error: any) => {
      console.error(`Server error on port ${PORT}:`, error);
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use`);
        process.exit(1);
      } else {
        logger.error('Failed to start server:', error);
        process.exit(1);
      }
    });

    // Initialize services AFTER server is listening (non-blocking)
    // This ensures Render detects the port even if these fail
    try {
      // Try to connect to MongoDB (non-blocking)
      connectDB().catch((err) => {
        console.warn('MongoDB connection failed, will retry:', err);
        logger.warn('MongoDB connection will be retried in background');
      });

      // Initialize Firebase Admin (optional)
      try {
        initializeFirebase();
      } catch (err) {
        console.warn('Firebase initialization failed:', err);
        logger.warn('Firebase initialization failed, continuing without it');
      }
    } catch (error) {
      console.warn('Error initializing services:', error);
      // Don't exit - server is already listening
    }
  } catch (error) {
    console.error('Critical error starting server:', error);
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (error: Error) => {
  logger.error('Unhandled promise rejection:', error);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start the server
startServer();


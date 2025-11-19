import { createApp } from './app';
import { connectDB } from './config/db';
import { initializeFirebase } from './config/firebase';
import { config } from './config/index';
import { logger } from './utils/logger';
import { createServer } from 'http';
import os from 'os';

const startServer = async (): Promise<void> => {
  try {
    // Try to connect to MongoDB (non-blocking)
    // Server will start even if MongoDB connection fails
    connectDB().catch(() => {
      logger.warn('MongoDB connection will be retried in background');
    });

    // Initialize Firebase Admin (optional)
    // This will log its own status messages
    initializeFirebase();

    // Create Express app
    const app = createApp();

    // Get port - prioritize process.env.PORT for Render compatibility
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : config.app.port;

    // Create HTTP server and listen on the specified port
    const server = createServer(app);
    
    server.listen(PORT, '0.0.0.0', () => {
      // Store server reference for graceful shutdown
      (global as any).httpServer = server;
      
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
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use`);
        process.exit(1);
      } else {
        logger.error('Failed to start server:', error);
        process.exit(1);
      }
    });
  } catch (error) {
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


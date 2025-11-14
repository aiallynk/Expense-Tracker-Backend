import { createApp } from './app';
import { connectDB } from './config/db';
import { initializeFirebase } from './config/firebase';
import { config } from './config/index';
import { logger } from './utils/logger';
import { createServer, Server } from 'http';
import { Express } from 'express';

const findAvailablePort = async (
  app: Express,
  startPort: number,
  maxAttempts: number = 10
): Promise<{ port: number; server: Server }> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = startPort + attempt;
    try {
      const server = await new Promise<Server>((resolve, reject) => {
        const httpServer = createServer(app);
        
        // Listen on all interfaces (0.0.0.0) to allow emulator connections
        httpServer.listen(port, '0.0.0.0', () => {
          resolve(httpServer);
        });

        httpServer.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error('PORT_IN_USE'));
          } else {
            reject(err);
          }
        });
      });
      
      return { port, server };
    } catch (error: any) {
      if (error.message === 'PORT_IN_USE') {
        continue; // Try next port
      }
      throw error;
    }
  }
  
  throw new Error(`Could not find available port after ${maxAttempts} attempts`);
};

const startServer = async (): Promise<void> => {
  try {
    // Connect to MongoDB
    await connectDB();

    // Initialize Firebase Admin (optional)
    // This will log its own status messages
    initializeFirebase();

    // Create Express app
    const app = createApp();

    // Find available port and start server
    const preferredPort = config.app.port;

    try {
      const { port, server } = await findAvailablePort(app, preferredPort);
      if (port !== preferredPort) {
        logger.warn(`Port ${preferredPort} is occupied, using port ${port} instead`);
      }
      
      // Store server reference for graceful shutdown
      (global as any).httpServer = server;
      
      logger.info(`Server running on port ${port}`);
      logger.info(`Environment: ${config.app.env}`);
      logger.info(`API available at http://localhost:${port}/api/v1`);
      logger.info(`For Android emulator, use: http://10.0.2.2:${port}/api/v1`);
    } catch (error) {
      logger.error('Failed to start server on any available port:', error);
      process.exit(1);
    }
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


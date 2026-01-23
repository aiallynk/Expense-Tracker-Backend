import mongoose from 'mongoose';

import { CategoriesService } from '../services/categories.service';

import { logger } from './logger';

import { config } from './index';

export const connectDB = async (): Promise<void> => {
  try {
    // Disable Mongoose debug logs and auto-index warnings
    mongoose.set('debug', false);
    mongoose.set('autoIndex', false);

    const uri = config.mongodb.uri.endsWith('/')
      ? `${config.mongodb.uri}${config.mongodb.dbName}`
      : `${config.mongodb.uri}/${config.mongodb.dbName}`;

    // Set connection options for better error handling and scalability
    // Optimized for 100K+ concurrent users
    const options = {
      // Connection pool settings for high concurrency
      maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '500', 10), // 500 connections for 100K users
      minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '10', 10), // Minimum 10 connections
      // Timeout settings
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
      socketTimeoutMS: 45000,
      // Connection management
      maxIdleTimeMS: 30000, // Close idle connections after 30s
      // Retry settings for better resilience
      retryWrites: true,
      retryReads: true,
    };

    await mongoose.connect(uri, options);
    logger.info('MongoDB connected successfully');

    // Initialize default categories
    try {
      await CategoriesService.initializeDefaultCategories();
      logger.info('Default categories initialized');
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize default categories');
      // Don't fail startup if categories can't be initialized
    }

    mongoose.connection.on('error', (err) => {
      logger.error({ error: err }, 'MongoDB connection error');
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });
  } catch (error: any) {
    logger.error({ error: error.message || error }, 'Failed to connect to MongoDB');
    logger.warn('Server will start without MongoDB. Some features may not work.');
    logger.warn('To fix: Ensure MongoDB is running and MONGODB_URI is set correctly in .env');
    // Don't exit - allow server to start without MongoDB for testing
    // process.exit(1);
  }
};

export const disconnectDB = async (): Promise<void> => {
  try {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected');
  } catch (error) {
    logger.error({ error }, 'Error disconnecting from MongoDB');
  }
};


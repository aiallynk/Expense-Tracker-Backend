import mongoose from 'mongoose';
import { config } from './index';
import { logger } from '../utils/logger';
import { CategoriesService } from '../services/categories.service';

export const connectDB = async (): Promise<void> => {
  try {
    const uri = config.mongodb.uri.endsWith('/')
      ? `${config.mongodb.uri}${config.mongodb.dbName}`
      : `${config.mongodb.uri}/${config.mongodb.dbName}`;

    // Set connection options for better error handling
    const options = {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
      socketTimeoutMS: 45000,
    };

    await mongoose.connect(uri, options);
    logger.info('MongoDB connected successfully');

    // Initialize default categories
    try {
      await CategoriesService.initializeDefaultCategories();
      logger.info('Default categories initialized');
    } catch (error) {
      logger.warn('Failed to initialize default categories:', error);
      // Don't fail startup if categories can't be initialized
    }

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });
  } catch (error: any) {
    logger.error('Failed to connect to MongoDB:', error.message || error);
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
    logger.error('Error disconnecting from MongoDB:', error);
  }
};


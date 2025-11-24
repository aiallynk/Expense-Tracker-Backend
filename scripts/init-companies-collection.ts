import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/db';
import { Company } from '../src/models/Company';
import { logger } from '../src/utils/logger';

/**
 * Script to initialize the companies collection in MongoDB
 * This ensures the collection exists and the model is registered
 */
const initCompaniesCollection = async () => {
  try {
    await connectDB();
    logger.info('Connected to MongoDB');

    // Check if collection exists
    const collections = await mongoose.connection.db.listCollections({ name: 'companies' }).toArray();
    
    if (collections.length > 0) {
      logger.info('Companies collection already exists');
      
      // Count documents
      const count = await Company.countDocuments();
      logger.info(`Companies collection has ${count} document(s)`);
    } else {
      logger.info('Companies collection does not exist, creating...');
      
      // Create the collection by creating an empty document and deleting it
      // This ensures indexes are created
      const tempCompany = new Company({
        name: '__temp_init__',
        status: 'active',
        plan: 'free',
      });
      
      await tempCompany.save();
      logger.info('Temporary company created to initialize collection');
      
      // Delete the temporary document
      await Company.deleteOne({ name: '__temp_init__' });
      logger.info('Temporary company deleted');
      
      logger.info('✅ Companies collection created successfully');
    }

    // Verify the model is registered
    const modelNames = mongoose.modelNames();
    if (modelNames.includes('Company')) {
      logger.info('✅ Company model is registered');
    } else {
      logger.warn('⚠️ Company model is not registered');
    }

    logger.info('Companies collection initialization completed');
  } catch (error: any) {
    logger.error('Error initializing companies collection:', error.message || error);
    process.exit(1);
  } finally {
    await disconnectDB();
  }
};

// Run the script
initCompaniesCollection();


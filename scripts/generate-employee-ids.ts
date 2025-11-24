/**
 * Migration Script: Generate Employee IDs for Existing Users
 * 
 * This script generates unique employee IDs for all active users who:
 * - Have a company assigned (companyId)
 * - Have a department assigned (departmentId)
 * - Don't have an employeeId yet
 * 
 * Run with: npm run generate-employee-ids
 * Or: npx ts-node scripts/generate-employee-ids.ts
 */

import mongoose from 'mongoose';
import { config } from '../src/config';
import { connectDB } from '../src/config/db';
import { User } from '../src/models/User';
import { EmployeeIdService } from '../src/services/employeeId.service';
import { logger } from '../src/utils/logger';
import { UserStatus } from '../src/utils/enums';

async function generateEmployeeIdsForExistingUsers() {
  try {
    // Connect to database
    logger.info('Connecting to database...');
    await connectDB();
    logger.info('Database connected successfully');

    // Find all active users who have company and department but no employeeId
    const usersToUpdate = await User.find({
      status: UserStatus.ACTIVE,
      companyId: { $exists: true, $ne: null },
      departmentId: { $exists: true, $ne: null },
      $or: [
        { employeeId: { $exists: false } },
        { employeeId: null },
        { employeeId: '' },
      ],
    })
      .select('_id name email companyId departmentId employeeId role')
      .populate('companyId', 'name shortcut')
      .exec();

    logger.info(`Found ${usersToUpdate.length} users without employee IDs`);

    if (usersToUpdate.length === 0) {
      logger.info('No users need employee IDs. All done!');
      process.exit(0);
    }

    let successCount = 0;
    let errorCount = 0;
    const errors: Array<{ userId: string; email: string; error: string }> = [];

    // Process users one by one to ensure proper sequential numbering
    for (const user of usersToUpdate) {
      try {
        if (!user.companyId) {
          logger.warn(`User ${user._id} (${user.email}) has no company, skipping...`);
          errorCount++;
          errors.push({
            userId: user._id.toString(),
            email: user.email || 'N/A',
            error: 'No company assigned',
          });
          continue;
        }

        // Check if user already has an employeeId (double-check)
        if (user.employeeId) {
          logger.info(`User ${user._id} (${user.email}) already has employee ID: ${user.employeeId}`);
          continue;
        }

        logger.info(`Generating employee ID for user: ${user.email} (${user._id})`);
        
        // Generate and assign employee ID
        const employeeId = await EmployeeIdService.assignEmployeeId(
          user._id,
          user.companyId,
          user.departmentId
        );

        if (employeeId) {
          logger.info(`✓ Generated employee ID ${employeeId} for ${user.email}`);
          successCount++;
        } else {
          logger.warn(`✗ Failed to generate employee ID for ${user.email}`);
          errorCount++;
          errors.push({
            userId: user._id.toString(),
            email: user.email || 'N/A',
            error: 'Failed to generate employee ID',
          });
        }
      } catch (error: any) {
        logger.error(`Error processing user ${user._id} (${user.email}):`, error);
        errorCount++;
        errors.push({
          userId: user._id.toString(),
          email: user.email || 'N/A',
          error: error.message || 'Unknown error',
        });
      }
    }

    // Print summary
    logger.info('\n=== Migration Summary ===');
    logger.info(`Total users processed: ${usersToUpdate.length}`);
    logger.info(`Successfully generated IDs: ${successCount}`);
    logger.info(`Errors: ${errorCount}`);

    if (errors.length > 0) {
      logger.warn('\n=== Errors ===');
      errors.forEach((err) => {
        logger.warn(`- User ${err.userId} (${err.email}): ${err.error}`);
      });
    }

    logger.info('\nMigration completed!');
  } catch (error: any) {
    logger.error('Fatal error during migration:', error);
    throw error;
  } finally {
    // Close database connection
    await mongoose.connection.close();
    logger.info('Database connection closed');
  }
}

// Run the migration
if (require.main === module) {
  generateEmployeeIdsForExistingUsers()
    .then(() => {
      logger.info('Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Script failed:', error);
      process.exit(1);
    });
}

export { generateEmployeeIdsForExistingUsers };


/**
 * Migration Script: Assign Unique Employee IDs to Existing Users
 * 
 * This script generates unique employee IDs in format ABC-DEF-0123 for all users who:
 * - Are not SUPER_ADMIN
 * - Have a company assigned (companyId) - required
 * - Don't have an employeeId yet (or have empty employeeId)
 * 
 * Format: ABC-DEF-0123
 * - ABC = Company shortcut (3 letters)
 * - DEF = Department shortcut (3 letters, or "XXX" if no department)
 * - 0123 = Unique random 4-digit number (expands to 5 digits when exhausted)
 * 
 * Run with: npm run assign-unique-ids
 * Or: npx ts-node scripts/assign-unique-ids-to-existing-users.ts
 */

import mongoose from 'mongoose';
import { connectDB } from '../src/config/db';
import { User } from '../src/models/User';
import { EmployeeIdService } from '../src/services/employeeId.service';
import { logger } from '../src/config/logger';
import { UserRole, UserStatus } from '../src/utils/enums';

async function assignUniqueIdsToExistingUsers() {
  try {
    // Connect to database
    logger.info('Connecting to database...');
    await connectDB();
    logger.info('Database connected successfully');

    // Find all users who:
    // - Are not SUPER_ADMIN
    // - Have a companyId (required for ID generation)
    // - Don't have an employeeId (or have empty/null employeeId)
    const usersToUpdate = await User.find({
      role: { $ne: UserRole.SUPER_ADMIN },
      companyId: { $exists: true, $ne: null },
      $or: [
        { employeeId: { $exists: false } },
        { employeeId: null },
        { employeeId: '' },
      ],
    })
      .select('_id name email companyId departmentId employeeId role status')
      .populate('companyId', 'name shortcut')
      .populate('departmentId', 'name code')
      .exec();

    logger.info(`Found ${usersToUpdate.length} users without unique employee IDs`);

    if (usersToUpdate.length === 0) {
      logger.info('No users need unique employee IDs. All done!');
      process.exit(0);
    }

    let successCount = 0;
    let errorCount = 0;
    const errors: Array<{ userId: string; email: string; error: string }> = [];

    // Process users one by one
    for (const user of usersToUpdate) {
      try {
        // Skip SUPER_ADMIN (double check)
        if (user.role === UserRole.SUPER_ADMIN || user.role === 'SUPER_ADMIN') {
          logger.info(`Skipping SUPER_ADMIN user: ${user.email} (${user._id})`);
          continue;
        }

        // Check if user already has an employeeId (double-check)
        if (user.employeeId && user.employeeId.trim().length > 0) {
          logger.info(`User ${user._id} (${user.email}) already has employee ID: ${user.employeeId}`);
          continue;
        }

        // Verify company exists
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

        logger.info(`Generating unique employee ID for user: ${user.email} (${user._id})`);
        
        // Generate unique employee ID using new format
        const employeeId = await EmployeeIdService.generateUniqueEmployeeId(
          user.companyId,
          user.departmentId || null,
          user._id
        );

        // Update user with new employee ID
        user.employeeId = employeeId;
        await user.save();

        logger.info(`✓ Generated and assigned unique employee ID ${employeeId} for ${user.email}`);
        successCount++;
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
    logger.info(`Total users found: ${usersToUpdate.length}`);
    logger.info(`Successfully assigned IDs: ${successCount}`);
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
  assignUniqueIdsToExistingUsers()
    .then(() => {
      logger.info('Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Script failed:', error);
      process.exit(1);
    });
}

export { assignUniqueIdsToExistingUsers };

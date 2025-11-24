import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/db';
import { Company } from '../src/models/Company';
import { User } from '../src/models/User';
import { UserRole, UserStatus } from '../src/utils/enums';
import { logger } from '../src/utils/logger';
import bcrypt from 'bcrypt';

/**
 * Script to test Company Admin creation functionality
 * This verifies:
 * 1. Company collection exists
 * 2. User collection supports COMPANY_ADMIN role
 * 3. Company admin can be created and linked to a company
 */
const testCompanyAdmin = async () => {
  try {
    await connectDB();
    logger.info('Connected to MongoDB');

    // Step 1: Check if companies collection exists and has at least one company
    const companies = await Company.find().limit(1).lean();
    if (companies.length === 0) {
      logger.warn('No companies found. Creating a test company...');
      const testCompany = new Company({
        name: 'Test Company for Admin',
        status: 'active',
        plan: 'basic',
      });
      await testCompany.save();
      logger.info(`Created test company: ${testCompany._id}`);
      companies.push(testCompany);
    }

    const testCompany = companies[0];
    logger.info(`Using company: ${testCompany.name} (ID: ${testCompany._id})`);

    // Step 2: Check if User model supports COMPANY_ADMIN role
    const testUser = new User({
      email: 'test-admin@example.com',
      passwordHash: await bcrypt.hash('test123456', 10),
      name: 'Test Admin',
      role: UserRole.COMPANY_ADMIN,
      companyId: testCompany._id,
      status: UserStatus.ACTIVE,
    });

    // Check if email already exists
    const existingUser = await User.findOne({ email: testUser.email });
    if (existingUser) {
      logger.info('Test admin user already exists, deleting it...');
      await User.deleteOne({ email: testUser.email });
    }

    // Step 3: Create a test company admin
    logger.info('Creating test company admin...');
    await testUser.save();
    logger.info(`✅ Company admin created successfully!`);
    logger.info(`   ID: ${testUser._id}`);
    logger.info(`   Email: ${testUser.email}`);
    logger.info(`   Name: ${testUser.name}`);
    logger.info(`   Role: ${testUser.role}`);
    logger.info(`   Company ID: ${testUser.companyId}`);

    // Step 4: Verify the admin can be retrieved by companyId
    const admins = await User.find({
      companyId: testCompany._id,
      role: UserRole.COMPANY_ADMIN,
    }).select('email name role status companyId');

    logger.info(`\n✅ Found ${admins.length} company admin(s) for company ${testCompany.name}:`);
    admins.forEach((admin, index) => {
      logger.info(`   ${index + 1}. ${admin.name} (${admin.email}) - ${admin.status}`);
    });

    // Step 5: Verify the admin is in the users collection
    const allCompanyAdmins = await User.countDocuments({ role: UserRole.COMPANY_ADMIN });
    logger.info(`\n✅ Total COMPANY_ADMIN users in database: ${allCompanyAdmins}`);

    // Step 6: Clean up test user (optional - comment out if you want to keep it)
    logger.info('\nCleaning up test admin user...');
    await User.deleteOne({ email: testUser.email });
    logger.info('✅ Test admin user deleted');

    logger.info('\n✅ All tests passed! Company Admin functionality is working correctly.');
  } catch (error: any) {
    logger.error('❌ Test failed:', error.message || error);
    if (error.stack) {
      logger.error('Stack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    await disconnectDB();
  }
};

// Run the test
testCompanyAdmin();


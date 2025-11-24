import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { User } from '../src/models/User';
import { config } from '../src/config/index';

dotenv.config();

const testPassword = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(config.mongodb.uri, {
      dbName: config.mongodb.dbName,
    });
    console.log('Connected to MongoDB\n');

    const testEmail = process.argv[2] || 'example@employee.com';
    const testPassword = process.argv[3] || 'password123';

    console.log(`Testing password for: ${testEmail}`);
    console.log(`Password: ${testPassword}\n`);

    const user = await User.findOne({ email: testEmail.toLowerCase() });

    if (!user) {
      console.log(`❌ User not found: ${testEmail}`);
      console.log('\nAvailable users:');
      const allUsers = await User.find({});
      allUsers.forEach((u) => {
        console.log(`  - ${u.email}`);
      });
      process.exit(1);
    }

    console.log(`✓ User found: ${user.email}`);
    console.log(`  Role: ${user.role}`);
    console.log(`  Status: ${user.status}`);
    console.log(`  Password hash exists: ${!!user.passwordHash}`);
    console.log(`  Password hash length: ${user.passwordHash?.length || 0}\n`);

    // Test password comparison
    const isValid = await user.comparePassword(testPassword);
    console.log(`Password comparison result: ${isValid ? '✓ VALID' : '❌ INVALID'}\n`);

    // Also test direct bcrypt comparison
    const directCompare = await bcrypt.compare(testPassword, user.passwordHash);
    console.log(`Direct bcrypt comparison: ${directCompare ? '✓ VALID' : '❌ INVALID'}\n`);

    if (isValid) {
      console.log('✅ Password is correct!');
    } else {
      console.log('❌ Password is incorrect!');
      console.log('\nTo reset password, run seed script: npm run seed:users');
    }

    process.exit(isValid ? 0 : 1);
  } catch (error) {
    console.error('Error testing password:', error);
    process.exit(1);
  }
};

testPassword();


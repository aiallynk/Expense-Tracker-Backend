import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from '../src/models/User';
import { config } from '../src/config/index';

dotenv.config();

const verifyUsers = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(config.mongodb.uri, {
      dbName: config.mongodb.dbName,
    });
    console.log('Connected to MongoDB\n');

    // Check if users exist
    const users = await User.find({});
    console.log(`Found ${users.length} users in database:\n`);

    if (users.length === 0) {
      console.log('❌ No users found! Please run: npm run seed:users\n');
      process.exit(1);
    }

    // List all users
    users.forEach((user) => {
      console.log(`✓ ${user.email} - Role: ${user.role} - Status: ${user.status}`);
    });

    // Check for seed users specifically
    const seedEmails = [
      'example@employee.com',
      'example@manager.com',
      'example@bh.com',
      'example@ca.com',
      'example@sa.com',
    ];

    console.log('\nChecking for seed users:');
    for (const email of seedEmails) {
      const user = await User.findOne({ email: email.toLowerCase() });
      if (user) {
        console.log(`✓ ${email} exists`);
      } else {
        console.log(`❌ ${email} NOT FOUND`);
      }
    }

    console.log('\n✅ Verification complete!');
    process.exit(0);
  } catch (error) {
    console.error('Error verifying users:', error);
    process.exit(1);
  }
};

verifyUsers();


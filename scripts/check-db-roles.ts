import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from '../src/models/User';
import { UserRole } from '../src/utils/enums';
import { config } from '../src/config/index';

dotenv.config();

const checkDbRoles = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(config.mongodb.uri, {
      dbName: config.mongodb.dbName,
    });
    console.log('Connected to MongoDB\n');

    // Get all users
    const users = await User.find({});
    console.log(`Total users in database: ${users.length}\n`);

    // Check available roles from enum
    console.log('Available roles in enum:');
    Object.values(UserRole).forEach((role) => {
      console.log(`  - ${role}`);
    });
    console.log('');

    // Group users by role
    const usersByRole: Record<string, any[]> = {};
    users.forEach((user) => {
      if (!usersByRole[user.role]) {
        usersByRole[user.role] = [];
      }
      usersByRole[user.role].push(user);
    });

    console.log('Users grouped by role:');
    Object.keys(usersByRole).forEach((role) => {
      console.log(`\n${role} (${usersByRole[role].length} users):`);
      usersByRole[role].forEach((user) => {
        console.log(`  - ${user.email} (Status: ${user.status})`);
      });
    });

    // Check for seed users specifically
    console.log('\n\nChecking seed users:');
    const seedEmails = [
      'example@employee.com',
      'example@manager.com',
      'example@bh.com',
      'example@ca.com',
      'example@sa.com',
    ];

    for (const email of seedEmails) {
      const user = await User.findOne({ email: email.toLowerCase() });
      if (user) {
        console.log(`✓ ${email}`);
        console.log(`    Role: ${user.role}`);
        console.log(`    Status: ${user.status}`);
        console.log(`    Has passwordHash: ${!!user.passwordHash}`);
        console.log(`    Password hash length: ${user.passwordHash?.length || 0}`);
      } else {
        console.log(`❌ ${email} NOT FOUND`);
      }
    }

    // Check for invalid roles
    console.log('\n\nChecking for invalid roles:');
    const validRoles = Object.values(UserRole);
    const invalidUsers = users.filter((user) => !validRoles.includes(user.role as UserRole));
    if (invalidUsers.length > 0) {
      console.log(`Found ${invalidUsers.length} users with invalid roles:`);
      invalidUsers.forEach((user) => {
        console.log(`  - ${user.email}: "${user.role}" (should be one of: ${validRoles.join(', ')})`);
      });
    } else {
      console.log('✓ All users have valid roles');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error checking database:', error);
    process.exit(1);
  }
};

checkDbRoles();


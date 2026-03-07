import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { User } from '../src/models/User';
import { UserRole, UserStatus } from '../src/utils/enums';
import { config } from '../src/config/index';

dotenv.config();

const seedUsers = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(config.mongodb.uri, {
      dbName: config.mongodb.dbName,
    });
    console.log('Connected to MongoDB');

    const defaultPasswordHash = await bcrypt.hash('password123', 10);
    const superAdminPasswordHash = await bcrypt.hash('111111', 10);

    // Seed users with different roles
    const users = [
      {
        email: 'example@employee.com',
        passwordHash: defaultPasswordHash,
        name: 'Employee User',
        role: UserRole.EMPLOYEE,
        status: UserStatus.ACTIVE,
      },
      {
        email: 'example@manager.com',
        passwordHash: defaultPasswordHash,
        name: 'Manager User',
        role: UserRole.MANAGER,
        status: UserStatus.ACTIVE,
      },
      {
        email: 'example@bh.com',
        passwordHash: defaultPasswordHash,
        name: 'Business Head User',
        role: UserRole.BUSINESS_HEAD,
        status: UserStatus.ACTIVE,
      },
      {
        email: 'example@ca.com',
        passwordHash: defaultPasswordHash,
        name: 'Company Admin User',
        role: UserRole.COMPANY_ADMIN,
        status: UserStatus.ACTIVE,
      },
      {
        email: 'example@sa.com',
        passwordHash: superAdminPasswordHash,
        name: 'Super Admin User',
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      {
        email: 'superadmin@aially.in',
        passwordHash: superAdminPasswordHash,
        name: 'Alternate Super Admin',
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    ];

    // Create or update users
    for (const userData of users) {
      const existingUser = await User.findOne({ email: userData.email });
      if (existingUser) {
        // Update existing user
        existingUser.passwordHash = userData.passwordHash;
        existingUser.name = userData.name;
        existingUser.role = userData.role;
        existingUser.status = userData.status;
        await existingUser.save();
        console.log(`✓ Updated user: ${userData.email} (${userData.role})`);
      } else {
        // Create new user
        const user = new User(userData);
        await user.save();
        console.log(`✓ Created user: ${userData.email} (${userData.role})`);
      }
    }

    console.log('\n✅ Seed completed successfully!');
    console.log('\nLogin credentials:');
    console.log('Email: example@employee.com | Password: password123 | Role: EMPLOYEE');
    console.log('Email: example@manager.com | Password: password123 | Role: MANAGER');
    console.log('Email: example@bh.com | Password: password123 | Role: BUSINESS_HEAD');
    console.log('Email: example@ca.com | Password: password123 | Role: COMPANY_ADMIN');
    console.log('Email: example@sa.com | Password: 111111 | Role: SUPER_ADMIN');
    console.log('Email: superadmin@aially.in | Password: 111111 | Role: SUPER_ADMIN');

    process.exit(0);
  } catch (error) {
    console.error('Error seeding users:', error);
    process.exit(1);
  }
};

seedUsers();


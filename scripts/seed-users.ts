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

    // Default password for all seed users
    const defaultPassword = 'password123';
    const passwordHash = await bcrypt.hash(defaultPassword, 10);

    // Seed users with different roles
    const users = [
      {
        email: 'example@employee.com',
        passwordHash,
        name: 'Employee User',
        role: UserRole.EMPLOYEE,
        status: UserStatus.ACTIVE,
      },
      {
        email: 'example@manager.com',
        passwordHash,
        name: 'Manager User',
        role: UserRole.MANAGER,
        status: UserStatus.ACTIVE,
      },
      {
        email: 'example@bh.com',
        passwordHash,
        name: 'Business Head User',
        role: UserRole.BUSINESS_HEAD,
        status: UserStatus.ACTIVE,
      },
      {
        email: 'example@ca.com',
        passwordHash,
        name: 'Company Admin User',
        role: UserRole.COMPANY_ADMIN,
        status: UserStatus.ACTIVE,
      },
      {
        email: 'example@sa.com',
        passwordHash,
        name: 'Super Admin User',
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
    console.log('Email: example@sa.com | Password: password123 | Role: SUPER_ADMIN');

    process.exit(0);
  } catch (error) {
    console.error('Error seeding users:', error);
    process.exit(1);
  }
};

seedUsers();


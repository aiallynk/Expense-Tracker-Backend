import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import { config } from '../src/config/index';
import { User } from '../src/models/User';
import { UserRole, UserStatus } from '../src/utils/enums';

dotenv.config();

const SUPER_ADMIN_PASSWORD = '111111';
const SUPER_ADMINS = [
  {
    email: 'example@sa.com',
    name: 'Super Admin User',
  },
  {
    email: 'superadmin@aially.in',
    name: 'Alternate Super Admin',
  },
];

async function ensureSuperAdmins(): Promise<void> {
  await mongoose.connect(config.mongodb.uri, {
    dbName: config.mongodb.dbName,
  });

  const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10);

  for (const account of SUPER_ADMINS) {
    const normalizedEmail = account.email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail }).exec();

    if (existingUser) {
      existingUser.email = normalizedEmail;
      existingUser.name = account.name;
      existingUser.passwordHash = passwordHash;
      existingUser.role = UserRole.SUPER_ADMIN;
      existingUser.status = UserStatus.ACTIVE;
      existingUser.companyId = undefined;
      existingUser.managerId = undefined;
      existingUser.departmentId = undefined;
      existingUser.employeeId = undefined;
      existingUser.passwordResetToken = undefined;
      existingUser.passwordResetExpires = undefined;
      await existingUser.save();
      console.log(`Updated super admin: ${normalizedEmail}`);
      continue;
    }

    const user = new User({
      email: normalizedEmail,
      name: account.name,
      passwordHash,
      role: UserRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    });
    await user.save();
    console.log(`Created super admin: ${normalizedEmail}`);
  }

  console.log('\nSuper admin credentials ensured:');
  for (const account of SUPER_ADMINS) {
    console.log(`Email: ${account.email} | Password: ${SUPER_ADMIN_PASSWORD}`);
  }
}

ensureSuperAdmins()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Failed to ensure super admin accounts:', error);
    await mongoose.disconnect();
    process.exit(1);
  });

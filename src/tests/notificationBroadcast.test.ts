import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { createApp } from '../app';
import { config } from '../config/index';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { UserRole, UserStatus } from '../utils/enums';

let mongo: MongoMemoryServer;

function signToken(payload: any) {
  return jwt.sign(payload, String(config.jwt.accessSecret), { expiresIn: '1h' });
}

describe('Super Admin Notification Broadcast System', () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'test' });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}).exec(),
      CompanyAdmin.deleteMany({}).exec(),
      Notification.deleteMany({}).exec(),
    ]);
  });

  it('rejects broadcast creation for non-SUPER_ADMIN', async () => {
    const admin = await User.create({
      email: 'admin@test.com',
      passwordHash: 'x',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    });
    const token = signToken({ id: admin._id.toString(), email: admin.email, role: admin.role });

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/admin/notifications/broadcast')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Hello',
        message: 'World',
        type: 'INFO',
        targetType: 'ALL_USERS',
        channels: ['IN_APP'],
        scheduledAt: null,
      });

    expect([401, 403]).toContain(res.status);
  });

  it('creates SCHEDULED broadcast when scheduledAt is in the future', async () => {
    const sa = await User.create({
      email: 'sa@test.com',
      passwordHash: 'x',
      role: UserRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    });
    const token = signToken({ id: sa._id.toString(), email: sa.email, role: sa.role });

    const app = createApp();
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await request(app)
      .post('/api/v1/admin/notifications/broadcast')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Scheduled',
        message: 'Later',
        type: 'MAINTENANCE',
        targetType: 'ALL_USERS',
        channels: ['IN_APP'],
        scheduledAt: future,
      });

    expect(res.status).toBe(201);
    expect(res.body?.success).toBe(true);
    expect(res.body?.data?.status).toBe('SCHEDULED');
  });

  it('sends IN_APP broadcast immediately to non-super-admin users + company admins', async () => {
    const sa = await User.create({
      email: 'sa2@test.com',
      passwordHash: 'x',
      role: UserRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    });
    const employee = await User.create({
      email: 'emp@test.com',
      passwordHash: 'x',
      role: UserRole.EMPLOYEE,
      status: UserStatus.ACTIVE,
    });
    const ca = await CompanyAdmin.create({
      email: 'ca@test.com',
      passwordHash: 'x',
      name: 'CA',
      companyId: new mongoose.Types.ObjectId(),
      status: 'active',
    });

    const token = signToken({ id: sa._id.toString(), email: sa.email, role: sa.role });

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/admin/notifications/broadcast')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Now',
        message: 'In-app only',
        type: 'INFO',
        targetType: 'ALL_USERS',
        channels: ['IN_APP'],
        scheduledAt: null,
      });

    expect(res.status).toBe(201);
    expect(res.body?.success).toBe(true);
    expect(res.body?.data?.status).toBe('SENT');

    // Should create per-recipient Notification rows (employee + company admin, not super admin)
    const count = await Notification.countDocuments({ title: 'Now' }).exec();
    expect(count).toBe(2);

    const recipients = await Notification.find({ title: 'Now' }).select('userId').lean().exec();
    const ids = recipients.map((r: any) => r.userId.toString());
    expect(ids).toContain(employee._id.toString());
    expect(ids).toContain(ca._id.toString());
  });
});



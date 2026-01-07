import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { createApp } from '../app';
import { config } from '../config/index';
import { User } from '../models/User';
import { UserRole, UserStatus } from '../utils/enums';

let mongo: MongoMemoryServer;

function signToken(payload: any) {
  return jwt.sign(payload, String(config.jwt.accessSecret), { expiresIn: '1h' });
}

describe('Report name defaulting', () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'test' });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({}).exec();
  });

  it('auto-generates default report name when name is blank', async () => {
    const user = await User.create({
      email: 'emp@test.com',
      passwordHash: 'x',
      name: 'John Doe',
      role: UserRole.EMPLOYEE,
      status: UserStatus.ACTIVE,
      companyId: new mongoose.Types.ObjectId(),
    });

    const token = signToken({ id: user._id.toString(), email: user.email, role: user.role });
    const app = createApp();

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: '',
        fromDate: new Date('2025-01-10T00:00:00Z').toISOString(),
        toDate: new Date('2025-01-31T00:00:00Z').toISOString(),
        projectId: '',
        costCentreId: '',
      });

    expect(res.status).toBe(201);
    expect(res.body?.success).toBe(true);
    expect(typeof res.body?.data?.name).toBe('string');
    expect(res.body.data.name).toContain('Expense Report');
    expect(res.body.data.name).toContain('January');
    expect(res.body.data.name).toContain('John Doe');
  });
});



import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { vi } from 'vitest';

import { createApp } from '../app';
import { config } from '../config/index';
import { User } from '../models/User';
import { UserRole, UserStatus } from '../utils/enums';
import { DocumentProcessingService } from '../services/documentProcessing.service';

let mongo: MongoMemoryServer;

function signToken(payload: any) {
  return jwt.sign(payload, String(config.jwt.accessSecret), { expiresIn: '1h' });
}

describe('Bulk upload confirm response shape', () => {
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
    vi.restoreAllMocks();
  });

  it('returns expensesCreated aligned with extractedData and includes results + correct created count in message', async () => {
    const user = await User.create({
      email: 'sa@test.com',
      passwordHash: 'x',
      role: UserRole.EMPLOYEE,
      status: UserStatus.ACTIVE,
      companyId: new mongoose.Types.ObjectId(),
    });

    const token = signToken({ id: user._id.toString(), email: user.email, role: user.role });
    const app = createApp();

    vi.spyOn(DocumentProcessingService, 'processDocument').mockResolvedValue({
      success: true,
      documentType: 'pdf',
      receipts: [
        { vendor: 'A', date: '2025-01-01', totalAmount: 10, invoiceId: 'INV1' },
        { vendor: 'B', date: '2025-01-02', totalAmount: 20, invoiceId: 'INV2' },
      ],
      expensesCreated: [null, 'exp_2'],
      results: [
        { index: 0, status: 'duplicate', duplicateExpense: { expenseId: 'exp_old' }, message: 'Duplicate' },
        { index: 1, status: 'created', expenseId: 'exp_2' },
      ],
      errors: [],
      totalPages: 2,
    } as any);

    const res = await request(app)
      .post('/api/v1/bulk-upload/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({
        storageKey: 'bulk-uploads/x/y',
        mimeType: 'application/pdf',
        reportId: '507f1f77bcf86cd799439011',
      });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(Array.isArray(res.body?.data?.extractedData)).toBe(true);
    expect(Array.isArray(res.body?.data?.expensesCreated)).toBe(true);
    expect(res.body.data.extractedData.length).toBe(2);
    expect(res.body.data.expensesCreated.length).toBe(2);
    expect(res.body.data.expensesCreated[0]).toBe(null);
    expect(res.body.data.expensesCreated[1]).toBe('exp_2');
    expect(Array.isArray(res.body?.data?.results)).toBe(true);
    expect(String(res.body?.message)).toContain('created 1 expense draft');
  });
});



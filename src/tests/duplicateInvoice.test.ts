import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { ExpenseReportStatus, ExpenseStatus, ExpenseSource, UserRole, UserStatus } from '../utils/enums';
import { DuplicateInvoiceService } from '../services/duplicateInvoice.service';

let mongo: MongoMemoryServer;

describe('DuplicateInvoiceService', () => {
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
      ExpenseReport.deleteMany({}).exec(),
      Expense.deleteMany({}).exec(),
    ]);
  });

  it('computes stable fingerprint across normalization variants', () => {
    const d = new Date('2025-01-02T12:34:56.000Z');
    const fp1 = DuplicateInvoiceService.computeFingerprint(' inv-001 ', 'ACME, Inc.', d, 123.4);
    const fp2 = DuplicateInvoiceService.computeFingerprint('INV001', 'acme inc', new Date('2025-01-02T00:00:00Z'), 123.40);
    expect(fp1).toBe(fp2);
  });

  it('detects duplicates across the company even when the existing expense is in a DRAFT report', async () => {
    const companyId = new mongoose.Types.ObjectId();
    const userA = await User.create({
      email: 'a@test.com',
      passwordHash: 'x',
      role: UserRole.EMPLOYEE,
      status: UserStatus.ACTIVE,
      companyId,
    });
    const userB = await User.create({
      email: 'b@test.com',
      passwordHash: 'x',
      role: UserRole.EMPLOYEE,
      status: UserStatus.ACTIVE,
      companyId,
    });

    const invoiceId = 'INV-1001';
    const vendor = 'Mega Store Pvt. Ltd.';
    const invoiceDate = new Date('2025-03-10T10:00:00Z');
    const amount = 999.5;

    const draftReport = await ExpenseReport.create({
      userId: userA._id,
      name: 'Draft report',
      fromDate: new Date('2025-03-01T00:00:00Z'),
      toDate: new Date('2025-03-31T00:00:00Z'),
      status: ExpenseReportStatus.DRAFT,
      totalAmount: 0,
      currency: 'INR',
      approvers: [],
    });

    // Draft report should still be considered for duplicates (strict duplicate prevention)
    await Expense.create({
      reportId: draftReport._id,
      userId: userA._id,
      vendor,
      amount,
      currency: 'INR',
      expenseDate: invoiceDate,
      status: ExpenseStatus.DRAFT,
      source: ExpenseSource.SCANNED,
      invoiceId,
      invoiceDate,
      invoiceFingerprint: DuplicateInvoiceService.computeFingerprint(invoiceId, vendor, invoiceDate, amount),
      receiptIds: [],
    });

    const check1 = await DuplicateInvoiceService.checkDuplicate(
      'inv 1001',
      'mega store pvt ltd',
      new Date('2025-03-10'),
      999.50,
      undefined,
      companyId
    );
    expect(check1.isDuplicate).toBe(true);
    expect(check1.duplicateExpense?.expenseId).toBeTruthy();

  });
});



import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { AdvanceCash, AdvanceCashStatus } from '../models/AdvanceCash';
import { AdvanceCashTransaction } from '../models/AdvanceCashTransaction';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { AdvanceCashService } from '../services/advanceCash.service';
import { ExpenseReportStatus, ExpenseSource, ExpenseStatus, UserRole, UserStatus } from '../utils/enums';

let mongo: MongoMemoryServer;

describe('AdvanceCashService.applyAdvanceForReport', () => {
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
      AdvanceCash.deleteMany({}).exec(),
      AdvanceCashTransaction.deleteMany({}).exec(),
    ]);
  });

  it('deducts from ACTIVE advances FIFO and marks settled when balance hits 0 (idempotent per expense)', async () => {
    const companyId = new mongoose.Types.ObjectId();
    const employee = await User.create({
      email: 'emp@test.com',
      passwordHash: 'x',
      role: UserRole.EMPLOYEE,
      status: UserStatus.ACTIVE,
      companyId,
    });

    const report = await ExpenseReport.create({
      userId: employee._id,
      name: 'R1',
      fromDate: new Date('2025-01-01T00:00:00Z'),
      toDate: new Date('2025-01-31T00:00:00Z'),
      status: ExpenseReportStatus.APPROVED,
      totalAmount: 0,
      currency: 'INR',
      approvers: [],
      approvedAt: new Date(),
    });

    // Create two advances FIFO: 100 then 50
    const adv1 = await AdvanceCash.create({
      companyId,
      employeeId: employee._id,
      amount: 100,
      balance: 100,
      currency: 'INR',
      status: AdvanceCashStatus.ACTIVE,
      createdBy: employee._id,
      createdAt: new Date('2025-01-02T00:00:00Z'),
      updatedAt: new Date('2025-01-02T00:00:00Z'),
    });
    const adv2 = await AdvanceCash.create({
      companyId,
      employeeId: employee._id,
      amount: 50,
      balance: 50,
      currency: 'INR',
      status: AdvanceCashStatus.ACTIVE,
      createdBy: employee._id,
      createdAt: new Date('2025-01-03T00:00:00Z'),
      updatedAt: new Date('2025-01-03T00:00:00Z'),
    });

    const expense = await Expense.create({
      reportId: report._id,
      userId: employee._id,
      vendor: 'Store',
      categoryId: new mongoose.Types.ObjectId(),
      amount: 120,
      currency: 'INR',
      expenseDate: new Date('2025-01-10T00:00:00Z'),
      status: ExpenseStatus.DRAFT,
      source: ExpenseSource.MANUAL,
      receiptIds: [],
      advanceAppliedAmount: 120,
    });

    const r1 = await AdvanceCashService.applyAdvanceForReport(report._id.toString());
    expect(r1.appliedExpenses).toBe(1);

    const tx = await AdvanceCashTransaction.findOne({ expenseId: expense._id }).exec();
    expect(tx).toBeTruthy();
    expect(tx!.amount).toBe(120);
    expect(tx!.allocations.length).toBe(2);
    expect(tx!.allocations[0].advanceCashId.toString()).toBe(adv1._id.toString());
    expect(tx!.allocations[0].amount).toBe(100);
    expect(tx!.allocations[1].advanceCashId.toString()).toBe(adv2._id.toString());
    expect(tx!.allocations[1].amount).toBe(20);

    const adv1After = await AdvanceCash.findById(adv1._id).exec();
    const adv2After = await AdvanceCash.findById(adv2._id).exec();
    expect(adv1After!.balance).toBe(0);
    expect(adv1After!.status).toBe(AdvanceCashStatus.SETTLED);
    expect(adv2After!.balance).toBe(30);
    expect(adv2After!.status).toBe(AdvanceCashStatus.ACTIVE);

    const expenseAfter = await Expense.findById(expense._id).exec();
    expect(expenseAfter!.advanceAppliedAt).toBeTruthy();
    expect(expenseAfter!.advanceAppliedAmount).toBe(120);

    // Idempotency: second call should skip
    const r2 = await AdvanceCashService.applyAdvanceForReport(report._id.toString());
    expect(r2.appliedExpenses).toBe(0);
  });
});



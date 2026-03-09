import mongoose from 'mongoose';

import { ApprovalInstance, ApprovalStatus } from '../src/models/ApprovalInstance';
import { ApprovalMatrix, ApprovalType } from '../src/models/ApprovalMatrix';
import { Company } from '../src/models/Company';
import { CostCentre } from '../src/models/CostCentre';
import { Category } from '../src/models/Category';
import { ExpenseReport } from '../src/models/ExpenseReport';
import { NotificationQueueService } from '../src/services/NotificationQueueService';
import { ApprovalService } from '../src/services/ApprovalService';
import { Project } from '../src/models/Project';
import { Receipt } from '../src/models/Receipt';
import { Role } from '../src/models/Role';
import { User } from '../src/models/User';
import {
  ExpenseReportStatus,
  UserRole,
  UserStatus,
} from '../src/utils/enums';

describe('additional approver flow', () => {
  let enqueueSpy: jest.SpiedFunction<typeof NotificationQueueService.enqueue>;

  const idOf = (value: { _id: unknown }): string =>
    (value._id as mongoose.Types.ObjectId).toString();

  beforeEach(() => {
    ApprovalService.invalidatePendingApprovalsCache();
    enqueueSpy = jest
      .spyOn(NotificationQueueService, 'enqueue')
      .mockResolvedValue('test-task');
  });

  afterEach(() => {
    ApprovalService.invalidatePendingApprovalsCache();
    enqueueSpy.mockRestore();
  });

  async function seedAdditionalApproverFlow() {
    // Import-only models above register populate refs used by approval/report services.
    expect(Role).toBeDefined();
    expect(Project).toBeDefined();
    expect(CostCentre).toBeDefined();
    expect(Category).toBeDefined();
    expect(Receipt).toBeDefined();

    const company = await Company.create({
      name: 'Acme Corp',
      domain: 'acme.example',
    });

    const manager = await User.create({
      email: 'manager@acme.example',
      passwordHash: 'hash',
      name: 'Manager',
      role: UserRole.MANAGER,
      companyId: company._id,
      status: UserStatus.ACTIVE,
    });

    const employee = await User.create({
      email: 'employee@acme.example',
      passwordHash: 'hash',
      name: 'Employee',
      role: UserRole.EMPLOYEE,
      companyId: company._id,
      managerId: manager._id,
      status: UserStatus.ACTIVE,
    });

    const accountant = await User.create({
      email: 'accountant@acme.example',
      passwordHash: 'hash',
      name: 'Accountant',
      role: UserRole.ACCOUNTANT,
      companyId: company._id,
      status: UserStatus.ACTIVE,
    });

    const matrix = await ApprovalMatrix.create({
      companyId: company._id,
      name: 'Default Matrix',
      isActive: true,
      levels: [
        {
          levelNumber: 1,
          enabled: true,
          approvalType: ApprovalType.SEQUENTIAL,
          approverUserIds: [manager._id],
          approverRoleIds: [],
          conditions: [],
          skipAllowed: false,
        },
      ],
    });

    const report = await ExpenseReport.create({
      userId: employee._id,
      name: 'Travel Report',
      fromDate: new Date('2026-03-01T00:00:00.000Z'),
      toDate: new Date('2026-03-02T00:00:00.000Z'),
      status: ExpenseReportStatus.PENDING_APPROVAL_L1,
      totalAmount: 1000,
      currency: 'INR',
      approvers: [
        {
          level: 1,
          userId: manager._id,
          role: 'MANAGER',
        },
        {
          level: 3,
          userId: accountant._id,
          role: 'Accountant',
          isAdditionalApproval: true,
          approvalRuleId: new mongoose.Types.ObjectId(),
          triggerReason: 'Report total (INR 1,000) exceeds threshold (INR 500)',
        },
      ],
    });

    const approvalInstance = await ApprovalInstance.create({
      companyId: company._id,
      matrixId: matrix._id,
      requestId: report._id,
      requestType: 'EXPENSE_REPORT',
      currentLevel: 1,
      status: ApprovalStatus.PENDING,
      history: [],
    });

    return {
      company,
      manager,
      employee,
      accountant,
      matrix,
      report,
      approvalInstance,
    };
  }

  it('hands off a matrix-approved report to the additional approver inbox', async () => {
    const { manager, accountant, report, approvalInstance } =
      await seedAdditionalApproverFlow();

    const managerPendingBefore = await ApprovalService.getPendingApprovalsForUser(
      idOf(manager),
      { page: 1, limit: 20 },
    );

    expect(managerPendingBefore.total).toBe(1);
    expect(managerPendingBefore.data[0]?.currentLevel).toBe(1);

    await ApprovalService.processAction(
      idOf(approvalInstance),
      idOf(manager),
      'APPROVE',
      'manager ok',
    );

    ApprovalService.invalidatePendingApprovalsCache();

    const reloadedInstance = await ApprovalInstance.findById(
      approvalInstance._id,
    ).lean();
    const reloadedReport = await ExpenseReport.findById(report._id).lean();
    const managerPendingAfter = await ApprovalService.getPendingApprovalsForUser(
      idOf(manager),
      { page: 1, limit: 20 },
    );
    const accountantPending = await ApprovalService.getPendingApprovalsForUser(
      idOf(accountant),
      { page: 1, limit: 20 },
    );

    expect(reloadedInstance?.status).toBe(ApprovalStatus.PENDING);
    expect(reloadedInstance?.currentLevel).toBe(3);
    expect(reloadedReport?.status).not.toBe(ExpenseReportStatus.APPROVED);
    expect(managerPendingAfter.total).toBe(0);
    expect(accountantPending.total).toBe(1);
    expect(accountantPending.data[0]?.currentLevel).toBe(3);
    expect(accountantPending.data[0]?.roleName).toBe('Accountant');
    expect(
      accountantPending.data[0]?.data?.additionalApproverInfo?.isAdditionalApproval,
    ).toBe(true);
    expect(
      accountantPending.data[0]?.data?.additionalApproverInfo?.isCurrentLevel,
    ).toBe(true);
    expect(
      accountantPending.data[0]?.data?.flags?.additional_approver_added,
    ).toBe(true);
  });

  it('completes final approval from the additional approver and preserves approval history', async () => {
    const { manager, accountant, report, approvalInstance } =
      await seedAdditionalApproverFlow();

    await ApprovalService.processAction(
      idOf(approvalInstance),
      idOf(manager),
      'APPROVE',
      'manager ok',
    );

    ApprovalService.invalidatePendingApprovalsCache();

    await ApprovalService.processAction(
      idOf(approvalInstance),
      idOf(accountant),
      'APPROVE',
      'finance ok',
    );

    const reloadedInstance = await ApprovalInstance.findById(
      approvalInstance._id,
    ).lean();
    const reloadedReport = await ExpenseReport.findById(report._id).lean();
    const additionalApprovalEntry = reloadedInstance?.history.find(
      (entry: any) =>
        entry.levelNumber === 3 && entry.status === ApprovalStatus.APPROVED,
    );

    expect(reloadedInstance?.status).toBe(ApprovalStatus.APPROVED);
    expect(reloadedInstance?.currentLevel).toBe(3);
    expect(reloadedReport?.status).toBe(ExpenseReportStatus.APPROVED);
    expect(additionalApprovalEntry).toBeDefined();
    expect(additionalApprovalEntry?.approverId?.toString()).toBe(
      idOf(accountant),
    );
    expect(additionalApprovalEntry?.comments).toBe('finance ok');
    expect(reloadedReport?.approvers.find((approver: any) => approver.level === 3))
      .toMatchObject({
        role: 'Accountant',
        isAdditionalApproval: true,
      });
  });
});

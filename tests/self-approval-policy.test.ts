import mongoose from 'mongoose';

import { ApprovalInstance, ApprovalStatus } from '../src/models/ApprovalInstance';
import { ApprovalMatrix, ApprovalType } from '../src/models/ApprovalMatrix';
import { Company } from '../src/models/Company';
import { CompanySettings } from '../src/models/CompanySettings';
import { ExpenseReport } from '../src/models/ExpenseReport';
import { ApprovalRecordService } from '../src/services/ApprovalRecordService';
import { NotificationQueueService } from '../src/services/NotificationQueueService';
import { ApprovalService } from '../src/services/ApprovalService';
import { Role } from '../src/models/Role';
import { User } from '../src/models/User';
import {
  ExpenseReportStatus,
  UserRole,
  UserStatus,
} from '../src/utils/enums';

describe('self approval policy', () => {
  let enqueueSpy: jest.SpiedFunction<typeof NotificationQueueService.enqueue>;
  let createApprovalRecordsSpy: jest.SpiedFunction<
    typeof ApprovalRecordService.createApprovalRecordsAtomic
  >;

  const idOf = (value: { _id: unknown }): string =>
    (value._id as mongoose.Types.ObjectId).toString();

  beforeEach(() => {
    ApprovalService.invalidatePendingApprovalsCache();
    enqueueSpy = jest
      .spyOn(NotificationQueueService, 'enqueue')
      .mockResolvedValue('test-task');
    createApprovalRecordsSpy = jest
      .spyOn(ApprovalRecordService, 'createApprovalRecordsAtomic')
      .mockImplementation(async (approvalInstance, matrix, _companyId, levelsToUse) => {
        const levels = Array.isArray(levelsToUse) && levelsToUse.length > 0
          ? levelsToUse
          : ((matrix as any)?.levels ?? []);
        const currentLevel = levels.find(
          (level: any) =>
            Number(level?.levelNumber ?? level?.level ?? 0) ===
            Number(approvalInstance.currentLevel),
        );
        const approverUserIds = (currentLevel?.approverUserIds ?? [])
          .map((id: any) => (id?._id ?? id)?.toString?.())
          .filter(Boolean);

        return {
          success: true,
          approverUserIds,
          levelConfig: currentLevel,
        } as any;
      });
  });

  afterEach(() => {
    ApprovalService.invalidatePendingApprovalsCache();
    createApprovalRecordsSpy.mockRestore();
    enqueueSpy.mockRestore();
  });

  async function seedSelfApprovalScenario(
    selfApprovalPolicy: 'ALLOW_SELF' | 'SKIP_SELF',
  ) {
    expect(Role).toBeDefined();

    const company = await Company.create({
      name: `Self Approval ${selfApprovalPolicy}`,
      domain: `${selfApprovalPolicy.toLowerCase()}.example`,
    });

    await CompanySettings.create({
      companyId: company._id,
      selfApprovalPolicy,
    });

    const employee = await User.create({
      email: `${selfApprovalPolicy.toLowerCase()}@example.com`,
      passwordHash: 'hash',
      name: `Employee ${selfApprovalPolicy}`,
      role: UserRole.EMPLOYEE,
      companyId: company._id,
      status: UserStatus.ACTIVE,
    });

    await ApprovalMatrix.create({
      companyId: company._id,
      name: `Matrix ${selfApprovalPolicy}`,
      isActive: true,
      levels: [
        {
          levelNumber: 1,
          enabled: true,
          approvalType: ApprovalType.SEQUENTIAL,
          approverUserIds: [employee._id],
          approverRoleIds: [],
          conditions: [],
          skipAllowed: false,
        },
      ],
    });

    const report = await ExpenseReport.create({
      userId: employee._id,
      name: `Report ${selfApprovalPolicy}`,
      fromDate: new Date('2026-03-01T00:00:00.000Z'),
      toDate: new Date('2026-03-02T00:00:00.000Z'),
      status: ExpenseReportStatus.DRAFT,
      totalAmount: 1200,
      currency: 'INR',
      approvers: [
        {
          level: 1,
          userId: employee._id,
          role: 'EMPLOYEE',
        },
      ],
    });

    const approvalInstance = await ApprovalService.initiateApproval(
      idOf(company),
      idOf(report),
      'EXPENSE_REPORT',
      report,
    );

    ApprovalService.invalidatePendingApprovalsCache();

    return {
      company,
      employee,
      report,
      approvalInstance,
    };
  }

  it('enforces self-skip even when policy is configured as ALLOW_SELF', async () => {
    const { employee, report, approvalInstance } =
      await seedSelfApprovalScenario('ALLOW_SELF');

    const pending = await ApprovalService.getPendingApprovalsForUser(
      idOf(employee),
      { page: 1, limit: 20 },
    );
    const reloadedInstance = await ApprovalInstance.findById(
      approvalInstance._id,
    ).lean();
    const reloadedReport = await ExpenseReport.findById(report._id).lean();

    expect(approvalInstance.status).toBe(ApprovalStatus.APPROVED);
    expect(pending.total).toBe(0);
    expect(reloadedInstance?.status).toBe(ApprovalStatus.APPROVED);
    expect(reloadedReport?.status).toBe(ExpenseReportStatus.APPROVED);
    expect(
      reloadedInstance?.history.some(
        (entry: any) =>
          entry.levelNumber === 1 &&
          entry.status === ApprovalStatus.SKIPPED,
      ),
    ).toBe(true);
    expect(reloadedReport?.approvalMeta?.policy).toBe('SKIP_SELF');
  });

  it('keeps skipping self approval when policy is SKIP_SELF', async () => {
    const { employee, report, approvalInstance } =
      await seedSelfApprovalScenario('SKIP_SELF');

    const pending = await ApprovalService.getPendingApprovalsForUser(
      idOf(employee),
      { page: 1, limit: 20 },
    );
    const reloadedInstance = await ApprovalInstance.findById(
      approvalInstance._id,
    ).lean();
    const reloadedReport = await ExpenseReport.findById(report._id).lean();

    expect(pending.total).toBe(0);
    expect(reloadedInstance?.status).toBe(ApprovalStatus.APPROVED);
    expect(reloadedReport?.status).toBe(ExpenseReportStatus.APPROVED);
    expect(
      reloadedInstance?.history.some(
        (entry: any) =>
          entry.levelNumber === 1 && entry.status === ApprovalStatus.SKIPPED,
      ),
    ).toBe(true);
    expect(reloadedReport?.approvalMeta?.policy).toBe('SKIP_SELF');
  });
});

import { ReportsService } from '../reports.service';
import { ExpenseReport } from '../../models/ExpenseReport';
import { Expense } from '../../models/Expense';
import { ExpenseReportStatus } from '../../utils/enums';

// Mock dependencies
jest.mock('../../models/ExpenseReport');
jest.mock('../../models/Expense');
jest.mock('../audit.service');
jest.mock('../notification.service');

describe('ReportsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createReport', () => {
    it('should create a new report with DRAFT status', async () => {
      const mockReport = {
        _id: 'report123',
        userId: 'user123',
        name: 'Test Report',
        status: ExpenseReportStatus.DRAFT,
        save: jest.fn().mockResolvedValue({
          _id: 'report123',
          userId: 'user123',
          name: 'Test Report',
          status: ExpenseReportStatus.DRAFT,
        }),
      };

      (ExpenseReport as any).mockImplementation(() => mockReport);

      const data = {
        name: 'Test Report',
        fromDate: '2024-01-01T00:00:00Z',
        toDate: '2024-01-31T23:59:59Z',
      };

      const result = await ReportsService.createReport('user123', data);

      expect(result.status).toBe(ExpenseReportStatus.DRAFT);
      expect(mockReport.save).toHaveBeenCalled();
    });
  });

  describe('submitReport', () => {
    it('should throw error if report has no expenses', async () => {
      const mockReport = {
        _id: 'report123',
        userId: 'user123',
        status: ExpenseReportStatus.DRAFT,
        save: jest.fn(),
      };

      (ExpenseReport.findById as jest.Mock).mockResolvedValue(mockReport);
      (Expense.countDocuments as jest.Mock).mockResolvedValue(0);

      await expect(
        ReportsService.submitReport('report123', 'user123')
      ).rejects.toThrow('Report must have at least one expense');
    });

    it('should submit report successfully', async () => {
      const mockReport = {
        _id: 'report123',
        userId: 'user123',
        name: 'Test Report',
        status: ExpenseReportStatus.DRAFT,
        submittedAt: undefined,
        updatedBy: undefined,
        save: jest.fn().mockResolvedValue({
          _id: 'report123',
          status: ExpenseReportStatus.SUBMITTED,
          submittedAt: new Date(),
        }),
      };

      (ExpenseReport.findById as jest.Mock).mockResolvedValue(mockReport);
      (Expense.countDocuments as jest.Mock).mockResolvedValue(1);

      const result = await ReportsService.submitReport('report123', 'user123');

      expect(result.status).toBe(ExpenseReportStatus.SUBMITTED);
      expect(mockReport.save).toHaveBeenCalled();
    });
  });
});


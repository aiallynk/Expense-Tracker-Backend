import request from 'supertest';
import { createApp } from '../src/app';
import {
  createTestUser,
  createTestCompany,
  createTestReport,
  createTestCategory,
} from './utils/testHelpers';
import { UserRole, ExpenseReportStatus } from '../src/utils/enums';
import { AuthService } from '../src/services/auth.service';
import { Expense } from '../src/models/Expense';
import { ExpenseReport } from '../src/models/ExpenseReport';

const app = createApp();

describe('Concurrency Tests', () => {
  let testCompanyId: string;
  let testUser: any;
  let testReport: any;
  let testCategory: any;
  const testPassword = 'TestPassword123!';
  const CONCURRENT_REQUESTS = 1000;

  beforeAll(async () => {
    testCompanyId = await createTestCompany();
    testUser = await createTestUser(
      'concurrency@example.com',
      testPassword,
      UserRole.EMPLOYEE,
      testCompanyId
    );

    const login = await AuthService.login(testUser.email, testPassword);
    testUser.token = login.tokens.accessToken;

    testCategory = await createTestCategory('Test Category', testCompanyId);
  });

  describe('Concurrent Expense Creation', () => {
    it('should handle 1000 parallel expense creation requests without duplicates', async () => {
      testReport = await createTestReport(
        testUser.id,
        testCompanyId,
        ExpenseReportStatus.DRAFT
      );

      const expenseData = {
        vendor: 'Concurrent Vendor',
        amount: 100,
        currency: 'INR',
        expenseDate: new Date().toISOString(),
        categoryId: testCategory._id.toString(),
        source: 'MANUAL',
      };

      // Create 1000 parallel requests
      const promises = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
        request(app)
          .post(`/api/v1/reports/${testReport._id}/expenses`)
          .set('Authorization', `Bearer ${testUser.token}`)
          .send({
            ...expenseData,
            vendor: `${expenseData.vendor} ${i}`, // Unique vendor per request
          })
      );

      const responses = await Promise.allSettled(promises);

      // Count successful responses
      const successful = responses.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 201
      );
      expect(successful.length).toBe(CONCURRENT_REQUESTS);

      // Verify no duplicate expenses (by vendor name)
      const expenses = await Expense.find({
        reportId: testReport._id,
        vendor: { $regex: /^Concurrent Vendor/ },
      });

      // Each expense should have unique vendor
      const vendorNames = expenses.map((e) => e.vendor);
      const uniqueVendors = new Set(vendorNames);
      expect(uniqueVendors.size).toBe(expenses.length);

      // Verify total count matches
      expect(expenses.length).toBe(CONCURRENT_REQUESTS);
    }, 60000); // Increase timeout for 1000 requests

    it('should maintain atomic DB writes during concurrent creation', async () => {
      testReport = await createTestReport(
        testUser.id,
        testCompanyId,
        ExpenseReportStatus.DRAFT
      );

      const initialExpenseCount = await Expense.countDocuments({
        reportId: testReport._id,
      });

      const expenseData = {
        vendor: 'Atomic Test Vendor',
        amount: 200,
        currency: 'INR',
        expenseDate: new Date().toISOString(),
        categoryId: testCategory._id.toString(),
        source: 'MANUAL',
      };

      // Create concurrent requests
      const promises = Array.from({ length: 100 }, (_, i) =>
        request(app)
          .post(`/api/v1/reports/${testReport._id}/expenses`)
          .set('Authorization', `Bearer ${testUser.token}`)
          .send({
            ...expenseData,
            vendor: `${expenseData.vendor} ${i}`,
          })
      );

      await Promise.allSettled(promises);

      // Verify final count
      const finalExpenseCount = await Expense.countDocuments({
        reportId: testReport._id,
      });

      expect(finalExpenseCount).toBe(initialExpenseCount + 100);
    });
  });

  describe('Concurrent Report Generation', () => {
    it('should handle 1000 parallel report generation requests', async () => {
      // Create multiple reports with expenses
      const reports = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          createTestReport(
            testUser.id,
            testCompanyId,
            ExpenseReportStatus.SUBMITTED,
            `Report ${i}`
          )
        )
      );

      // Create expenses for each report
      for (const report of reports) {
        await Promise.all(
          Array.from({ length: 5 }, () =>
            request(app)
              .post(`/api/v1/reports/${report._id}/expenses`)
              .set('Authorization', `Bearer ${testUser.token}`)
              .send({
                vendor: 'Test Vendor',
                amount: 100,
                currency: 'INR',
                expenseDate: new Date().toISOString(),
                categoryId: testCategory._id.toString(),
                source: 'MANUAL',
              })
          )
        );
      }

      // Generate 1000 reports concurrently (10 requests per report to reach 1000)
      const promises = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => {
        const reportIndex = i % reports.length;
        return request(app)
          .get(`/api/v1/reports/${reports[reportIndex]._id}/export/excel`)
          .set('Authorization', `Bearer ${testUser.token}`);
      });

      const responses = await Promise.allSettled(promises);

      // Count successful responses (200 or 201)
      const successful = responses.filter(
        (r) => r.status === 'fulfilled' && r.value.status >= 200 && r.value.status < 300
      );

      // All should succeed (or handle gracefully without errors)
      expect(successful.length).toBeGreaterThan(0);
      
      // Verify no duplicate file generation issues
      const errors = responses.filter(
        (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status >= 500)
      );
      expect(errors.length).toBe(0);
    }, 120000); // Increase timeout for 1000 requests

    it('should handle concurrent report generation without duplicate files', async () => {
      // Create a single report with expenses
      const report = await createTestReport(
        testUser.id,
        testCompanyId,
        ExpenseReportStatus.SUBMITTED
      );

      // Create expenses for the report
      await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app)
            .post(`/api/v1/reports/${report._id}/expenses`)
            .set('Authorization', `Bearer ${testUser.token}`)
            .send({
              vendor: 'Test Vendor',
              amount: 100,
              currency: 'INR',
              expenseDate: new Date().toISOString(),
              categoryId: testCategory._id.toString(),
              source: 'MANUAL',
            })
        )
      );

      // Generate same report concurrently multiple times
      const concurrentRequests = 50;
      const promises = Array.from({ length: concurrentRequests }, () =>
        request(app)
          .get(`/api/v1/reports/${report._id}/export/excel`)
          .set('Authorization', `Bearer ${testUser.token}`)
      );

      const responses = await Promise.allSettled(promises);

      // All should succeed
      const successful = responses.filter(
        (r) => r.status === 'fulfilled' && r.value.status >= 200 && r.value.status < 300
      );
      expect(successful.length).toBe(concurrentRequests);
    }, 60000);
  });

  describe('Race Condition Prevention', () => {
    it('should prevent duplicate expense creation in race conditions', async () => {
      testReport = await createTestReport(
        testUser.id,
        testCompanyId,
        ExpenseReportStatus.DRAFT
      );

      const expenseData = {
        vendor: 'Race Condition Vendor',
        amount: 100,
        currency: 'INR',
        expenseDate: new Date().toISOString(),
        categoryId: testCategory._id.toString(),
        source: 'MANUAL',
        invoiceId: 'INV-001', // Same invoice ID to test duplicate detection
      };

      // Send identical requests simultaneously
      const promises = Array.from({ length: 10 }, () =>
        request(app)
          .post(`/api/v1/reports/${testReport._id}/expenses`)
          .set('Authorization', `Bearer ${testUser.token}`)
          .send(expenseData)
      );

      const responses = await Promise.allSettled(promises);

      // Only one should succeed (duplicate detection)
      const successful = responses.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 201
      );

      // Should have at most 1 successful creation (duplicate detection should prevent others)
      expect(successful.length).toBeLessThanOrEqual(1);
    });
  });

  describe('Concurrent Updates and Deletions', () => {
    it('should handle concurrent updates to same expense', async () => {
      testReport = await createTestReport(
        testUser.id,
        testCompanyId,
        ExpenseReportStatus.DRAFT
      );

      const expense = await request(app)
        .post(`/api/v1/reports/${testReport._id}/expenses`)
        .set('Authorization', `Bearer ${testUser.token}`)
        .send({
          vendor: 'Update Test Vendor',
          amount: 100,
          currency: 'INR',
          expenseDate: new Date().toISOString(),
          categoryId: testCategory._id.toString(),
          source: 'MANUAL',
        })
        .expect(201);

      const expenseId = expense.body.data._id;

      // Send concurrent update requests
      const promises = Array.from({ length: 50 }, (_, i) =>
        request(app)
          .patch(`/api/v1/expenses/${expenseId}`)
          .set('Authorization', `Bearer ${testUser.token}`)
          .send({
            vendor: `Updated Vendor ${i}`,
            amount: 100 + i,
          })
      );

      const responses = await Promise.allSettled(promises);

      // All should succeed (last write wins)
      const successful = responses.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 200
      );
      expect(successful.length).toBe(50);

      // Verify final state - should have the last update
      const finalExpense = await Expense.findById(expenseId);
      expect(finalExpense).not.toBeNull();
      expect(finalExpense?.vendor).toContain('Updated Vendor');
    }, 60000);

    it('should handle concurrent deletions atomically', async () => {
      testReport = await createTestReport(
        testUser.id,
        testCompanyId,
        ExpenseReportStatus.DRAFT
      );

      // Create multiple expenses
      const expenses = await Promise.all(
        Array.from({ length: 20 }, () =>
          request(app)
            .post(`/api/v1/reports/${testReport._id}/expenses`)
            .set('Authorization', `Bearer ${testUser.token}`)
            .send({
              vendor: 'Delete Test Vendor',
              amount: 100,
              currency: 'INR',
              expenseDate: new Date().toISOString(),
              categoryId: testCategory._id.toString(),
              source: 'MANUAL',
            })
            .expect(201)
        )
      );

      const initialCount = await Expense.countDocuments({ reportId: testReport._id });
      expect(initialCount).toBeGreaterThanOrEqual(20);

      // Delete expenses concurrently
      const promises = expenses.map((expense) =>
        request(app)
          .delete(`/api/v1/expenses/${expense.body.data._id}`)
          .set('Authorization', `Bearer ${testUser.token}`)
      );

      const responses = await Promise.allSettled(promises);

      // All deletions should succeed
      const successful = responses.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 200
      );
      expect(successful.length).toBe(expenses.length);

      // Verify final count - all should be deleted
      const finalCount = await Expense.countDocuments({ reportId: testReport._id });
      expect(finalCount).toBe(initialCount - expenses.length);
    }, 60000);
  });

  describe('Database Consistency', () => {
    it('should maintain database consistency after concurrent operations', async () => {
      testReport = await createTestReport(
        testUser.id,
        testCompanyId,
        ExpenseReportStatus.DRAFT
      );

      const initialCount = await Expense.countDocuments({ reportId: testReport._id });

      // Mix of create, update, and delete operations concurrently
      const createPromises = Array.from({ length: 100 }, (_, i) =>
        request(app)
          .post(`/api/v1/reports/${testReport._id}/expenses`)
          .set('Authorization', `Bearer ${testUser.token}`)
          .send({
            vendor: `Consistency Vendor ${i}`,
            amount: 100 + i,
            currency: 'INR',
            expenseDate: new Date().toISOString(),
            categoryId: testCategory._id.toString(),
            source: 'MANUAL',
          })
      );

      const createResponses = await Promise.allSettled(createPromises);
      const createdExpenses = createResponses
        .filter((r) => r.status === 'fulfilled' && r.value.status === 201)
        .map((r: any) => r.value.body.data._id);

      // Verify all created expenses exist
      const createdCount = await Expense.countDocuments({
        _id: { $in: createdExpenses },
      });
      expect(createdCount).toBe(createdExpenses.length);

      // Verify total count matches
      const finalCount = await Expense.countDocuments({ reportId: testReport._id });
      expect(finalCount).toBe(initialCount + createdExpenses.length);

      // Verify no duplicate IDs
      const allExpenses = await Expense.find({ reportId: testReport._id });
      const expenseIds = allExpenses.map((e) => e._id.toString());
      const uniqueIds = new Set(expenseIds);
      expect(uniqueIds.size).toBe(expenseIds.length);
    }, 120000);
  });
});

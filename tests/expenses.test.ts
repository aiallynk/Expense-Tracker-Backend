import request from 'supertest';
import { createApp } from '../src/app';
import {
  createTestUser,
  createTestCompany,
  createTestCategory,
  createTestReport,
  createTestExpense,
  createMultipleTestExpenses,
} from './utils/testHelpers';
import { UserRole, ExpenseReportStatus, ExpenseStatus } from '../src/utils/enums';
import { AuthService } from '../src/services/auth.service';
import { Expense } from '../src/models/Expense';

const app = createApp();

describe('Expense API Tests', () => {
  let testCompanyId: string;
  let testUser: any;
  let testReport: any;
  let testCategory: any;
  const testPassword = 'TestPassword123!';

  beforeAll(async () => {
    testCompanyId = await createTestCompany();
    testUser = await createTestUser(
      'expenseuser@example.com',
      testPassword,
      UserRole.EMPLOYEE,
      testCompanyId
    );

    const login = await AuthService.login(testUser.email, testPassword);
    testUser.token = login.tokens.accessToken;

    testReport = await createTestReport(testUser.id, testCompanyId, ExpenseReportStatus.DRAFT);
    testCategory = await createTestCategory('Test Category', testCompanyId);
  });

  describe('POST /api/v1/reports/:reportId/expenses', () => {
    it('should create expense successfully', async () => {
      const expenseData = {
        vendor: 'Test Vendor',
        amount: 1000,
        currency: 'INR',
        expenseDate: new Date().toISOString(),
        categoryId: testCategory._id.toString(),
        source: 'MANUAL',
      };

      const response = await request(app)
        .post(`/api/v1/reports/${testReport._id}/expenses`)
        .set('Authorization', `Bearer ${testUser.token}`)
        .send(expenseData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('_id');
      expect(response.body.data.vendor).toBe(expenseData.vendor);
      expect(response.body.data.amount).toBe(expenseData.amount);
    });

    it('should reject expense creation with invalid report ID', async () => {
      const expenseData = {
        vendor: 'Test Vendor',
        amount: 1000,
        currency: 'INR',
        expenseDate: new Date().toISOString(),
      };

      const response = await request(app)
        .post('/api/v1/reports/invalid-id/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .send(expenseData)
        .expect(404);

      expect(response.body.success).toBe(false);
    });

    it('should reject expense creation without required fields', async () => {
      const response = await request(app)
        .post(`/api/v1/reports/${testReport._id}/expenses`)
        .set('Authorization', `Bearer ${testUser.token}`)
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('PATCH /api/v1/expenses/:id', () => {
    it('should update expense successfully', async () => {
      const expense = await createTestExpense(
        testUser.id,
        testReport._id.toString(),
        testCategory._id.toString(),
        500
      );

      const updateData = {
        vendor: 'Updated Vendor',
        amount: 1500,
      };

      const response = await request(app)
        .patch(`/api/v1/expenses/${expense._id}`)
        .set('Authorization', `Bearer ${testUser.token}`)
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.vendor).toBe(updateData.vendor);
      expect(response.body.data.amount).toBe(updateData.amount);
    });

    it('should reject update with invalid expense ID', async () => {
      const response = await request(app)
        .patch('/api/v1/expenses/invalid-id')
        .set('Authorization', `Bearer ${testUser.token}`)
        .send({ vendor: 'Updated' })
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  describe('DELETE /api/v1/expenses/:id', () => {
    it('should delete expense successfully', async () => {
      const expense = await createTestExpense(
        testUser.id,
        testReport._id.toString(),
        testCategory._id.toString(),
        300
      );

      const response = await request(app)
        .delete(`/api/v1/expenses/${expense._id}`)
        .set('Authorization', `Bearer ${testUser.token}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('deleted successfully');

      // Verify expense is deleted
      const deletedExpense = await Expense.findById(expense._id);
      expect(deletedExpense).toBeNull();
    });

    it('should reject deletion with invalid expense ID', async () => {
      const response = await request(app)
        .delete('/api/v1/expenses/invalid-id')
        .set('Authorization', `Bearer ${testUser.token}`)
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  describe('Category Linked Expense Deletion', () => {
    it('should block category deletion if linked to expenses', async () => {
      // Create expense with category
      const category = await createTestCategory('Linked Category', testCompanyId);
      const expense = await createTestExpense(
        testUser.id,
        testReport._id.toString(),
        category._id.toString(),
        200
      );

      // Try to delete category - should fail
      const response = await request(app)
        .delete(`/api/v1/categories/${category._id}`)
        .set('Authorization', `Bearer ${testUser.token}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('already in use');
    });

    it('should allow category deletion if not linked to expenses', async () => {
      const category = await createTestCategory('Unlinked Category', testCompanyId);

      // Create a company admin to delete category
      const companyAdmin = await createTestUser(
        'admin2@example.com',
        testPassword,
        UserRole.COMPANY_ADMIN,
        testCompanyId
      );
      const adminLogin = await AuthService.login(companyAdmin.email, testPassword);
      const adminToken = adminLogin.tokens.accessToken;

      const response = await request(app)
        .delete(`/api/v1/categories/${category._id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('Pagination & Filtering', () => {
    let paginationReport: any;
    let paginationCategory: any;
    let statusCategory: any;

    beforeEach(async () => {
      // Create a fresh report and category for pagination tests
      paginationReport = await createTestReport(testUser.id, testCompanyId, ExpenseReportStatus.DRAFT);
      paginationCategory = await createTestCategory('Pagination Category', testCompanyId);
      statusCategory = await createTestCategory('Status Category', testCompanyId);
    });

    it('should return paginated expenses with accurate pagination metadata', async () => {
      // Create 25 expenses
      await createMultipleTestExpenses(
        testUser.id,
        paginationReport._id.toString(),
        paginationCategory._id.toString(),
        25,
        100
      );

      const page = 1;
      const pageSize = 10;

      const response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({ page, pageSize })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeLessThanOrEqual(pageSize);
      
      // Verify pagination metadata accuracy
      expect(response.body.pagination).toBeDefined();
      expect(response.body.pagination.page).toBe(page);
      expect(response.body.pagination.pageSize).toBe(pageSize);
      expect(response.body.pagination.total).toBeGreaterThanOrEqual(25);
      expect(response.body.pagination.totalPages).toBeGreaterThanOrEqual(Math.ceil(25 / pageSize));
    });

    it('should handle pagination across multiple pages correctly', async () => {
      // Create 25 expenses
      await createMultipleTestExpenses(
        testUser.id,
        paginationReport._id.toString(),
        paginationCategory._id.toString(),
        25,
        100
      );

      const pageSize = 10;
      
      // Get first page
      const page1Response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({ page: 1, pageSize })
        .expect(200);

      // Get second page
      const page2Response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({ page: 2, pageSize })
        .expect(200);

      // Get third page
      const page3Response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({ page: 3, pageSize })
        .expect(200);

      // Verify no duplicates across pages
      const page1Ids = page1Response.body.data.map((e: any) => e._id.toString());
      const page2Ids = page2Response.body.data.map((e: any) => e._id.toString());
      const page3Ids = page3Response.body.data.map((e: any) => e._id.toString());

      const allIds = [...page1Ids, ...page2Ids, ...page3Ids];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);

      // Verify total is consistent across pages
      expect(page1Response.body.pagination.total).toBe(page2Response.body.pagination.total);
      expect(page2Response.body.pagination.total).toBe(page3Response.body.pagination.total);
    });

    it('should filter expenses by date range accurately', async () => {
      // Create expenses with different dates
      const fromDate = new Date('2024-01-15');
      const toDate = new Date('2024-01-20');

      // Create expenses outside date range
      for (let i = 0; i < 5; i++) {
        await createTestExpense(
          testUser.id,
          paginationReport._id.toString(),
          paginationCategory._id.toString(),
          100,
          new Date('2024-01-01')
        );
      }

      // Create expenses within date range
      for (let i = 0; i < 5; i++) {
        const expense = new Expense({
          userId: testUser.id,
          reportId: paginationReport._id,
          vendor: `Vendor ${i}`,
          amount: 100 + i * 10,
          currency: 'INR',
          expenseDate: new Date(2024, 0, 15 + i), // Jan 15-19
          status: ExpenseStatus.PENDING,
          source: 'MANUAL',
          categoryId: paginationCategory._id,
        });
        await expense.save();
      }

      const response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({
          fromDate: fromDate.toISOString(),
          toDate: toDate.toISOString(),
          page: 1,
          pageSize: 20,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeInstanceOf(Array);
      
      // Verify all expenses are within date range
      response.body.data.forEach((expense: any) => {
        const expenseDate = new Date(expense.expenseDate);
        expect(expenseDate.getTime()).toBeGreaterThanOrEqual(fromDate.getTime());
        expect(expenseDate.getTime()).toBeLessThanOrEqual(toDate.getTime());
      });
    });

    it('should filter expenses by category accurately', async () => {
      const otherCategory = await createTestCategory('Other Category', testCompanyId);

      // Create expenses with different categories
      await createMultipleTestExpenses(
        testUser.id,
        paginationReport._id.toString(),
        paginationCategory._id.toString(),
        5,
        100
      );
      await createMultipleTestExpenses(
        testUser.id,
        paginationReport._id.toString(),
        otherCategory._id.toString(),
        5,
        200
      );

      const response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({
          categoryId: paginationCategory._id.toString(),
          page: 1,
          pageSize: 20,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeInstanceOf(Array);
      
      // Verify all returned expenses have the correct category
      response.body.data.forEach((expense: any) => {
        if (expense.categoryId) {
          expect(expense.categoryId.toString()).toBe(paginationCategory._id.toString());
          expect(expense.categoryId.toString()).not.toBe(otherCategory._id.toString());
        }
      });
    });

    it('should filter expenses by status accurately', async () => {
      // Create expenses with different statuses
      for (let i = 0; i < 5; i++) {
        const expense = new Expense({
          userId: testUser.id,
          reportId: paginationReport._id,
          vendor: `Pending Vendor ${i}`,
          amount: 100 + i * 10,
          currency: 'INR',
          expenseDate: new Date(),
          status: ExpenseStatus.PENDING,
          source: 'MANUAL',
          categoryId: paginationCategory._id,
        });
        await expense.save();
      }

      for (let i = 0; i < 3; i++) {
        const expense = new Expense({
          userId: testUser.id,
          reportId: paginationReport._id,
          vendor: `Approved Vendor ${i}`,
          amount: 200 + i * 10,
          currency: 'INR',
          expenseDate: new Date(),
          status: ExpenseStatus.APPROVED,
          source: 'MANUAL',
          categoryId: paginationCategory._id,
        });
        await expense.save();
      }

      const response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({
          status: ExpenseStatus.PENDING,
          page: 1,
          pageSize: 20,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      
      // Verify all returned expenses have PENDING status
      response.body.data.forEach((expense: any) => {
        expect(expense.status).toBe(ExpenseStatus.PENDING);
      });
    });

    it('should filter expenses by reportId accurately', async () => {
      const otherReport = await createTestReport(testUser.id, testCompanyId, ExpenseReportStatus.DRAFT);

      // Create expenses in different reports
      await createMultipleTestExpenses(
        testUser.id,
        paginationReport._id.toString(),
        paginationCategory._id.toString(),
        5,
        100
      );
      await createMultipleTestExpenses(
        testUser.id,
        otherReport._id.toString(),
        paginationCategory._id.toString(),
        5,
        200
      );

      const response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({
          reportId: paginationReport._id.toString(),
          page: 1,
          pageSize: 20,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      
      // Verify all returned expenses belong to the specified report
      response.body.data.forEach((expense: any) => {
        expect(expense.reportId.toString()).toBe(paginationReport._id.toString());
        expect(expense.reportId.toString()).not.toBe(otherReport._id.toString());
      });
    });

    it('should handle empty results gracefully', async () => {
      const response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({
          categoryId: '507f1f77bcf86cd799439011', // Non-existent category
          page: 1,
          pageSize: 10,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBe(0);
      expect(response.body.pagination.total).toBe(0);
    });

    it('should handle invalid filter parameters gracefully', async () => {
      const response = await request(app)
        .get('/api/v1/expenses')
        .set('Authorization', `Bearer ${testUser.token}`)
        .query({
          page: 'invalid',
          pageSize: 'invalid',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });
});

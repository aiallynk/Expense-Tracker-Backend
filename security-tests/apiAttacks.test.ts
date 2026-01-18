import request from 'supertest';
import { createApp } from '../../src/app';
import {
  createTestUser,
  createTestCompany,
  createTestReport,
  createTestCategory,
  createTestExpense,
} from '../tests/utils/testHelpers';
import { UserRole } from '../../src/utils/enums';
import { AuthService } from '../../src/services/auth.service';
// Inline security helpers
const nosqlInjectionPayloads = {
  queryParams: [
    { email: { $ne: null } },
    { email: { $regex: '.*' } },
  ],
  bodyPayloads: [
    { email: { $ne: null }, password: 'test' },
  ],
};

const massAssignmentPayloads = {
  adminRole: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
  companyId: { companyId: '507f1f77bcf86cd799439011' },
};

const app = createApp();

describe('API Security Attacks', () => {
  let user1: any;
  let user2: any;
  let company1Id: string;
  let company2Id: string;
  let expense1: any;
  let report1: any;
  const testPassword = 'TestPassword123!';

  beforeAll(async () => {
    // Create two companies for cross-company access tests
    company1Id = await createTestCompany('Company 1');
    company2Id = await createTestCompany('Company 2');

    // Create users in different companies
    user1 = await createTestUser(
      'user1@company1.com',
      testPassword,
      UserRole.EMPLOYEE,
      company1Id
    );
    user2 = await createTestUser(
      'user2@company2.com',
      testPassword,
      UserRole.EMPLOYEE,
      company2Id
    );

    // Get tokens
    const login1 = await AuthService.login(user1.email, testPassword);
    user1.token = login1.tokens.accessToken;

    const login2 = await AuthService.login(user2.email, testPassword);
    user2.token = login2.tokens.accessToken;

    // Create test data
    report1 = await createTestReport(user1.id, company1Id);
    const category1 = await createTestCategory('Category 1', company1Id);
    expense1 = await createTestExpense(
      user1.id,
      report1._id.toString(),
      category1._id.toString()
    );
  });

  describe('NoSQL Injection Attacks', () => {
    describe('Login Endpoint Injection', () => {
      it('should reject NoSQL injection in email field (query parameter style)', async () => {
        // Try to bypass authentication with $ne operator
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({
            email: { $ne: null },
            password: testPassword,
          })
          .expect(400); // Should fail validation

        expect(response.body.success).toBe(false);
      });

      it('should reject NoSQL injection with $regex operator', async () => {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({
            email: { $regex: '.*' },
            password: testPassword,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
      });

      it('should reject NoSQL injection with $where operator', async () => {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({
            email: { $where: "this.password == this.email" },
            password: testPassword,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
      });

      it('should reject NoSQL injection with $or operator', async () => {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({
            $or: [
              { email: 'admin@example.com' },
              { email: { $ne: null } },
            ],
            password: testPassword,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
      });
    });

    describe('User Query Injection', () => {
      it('should reject NoSQL injection in user search query', async () => {
        // Try to inject in search parameter
        const maliciousQueries = [
          { search: { $ne: null } },
          { search: { $regex: '.*' } },
          { role: { $ne: 'EMPLOYEE' } },
        ];

        for (const query of maliciousQueries) {
          const response = await request(app)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${user1.token}`)
            .query(query)
            .expect(400); // Should fail validation

          expect(response.body.success).toBe(false);
        }
      });
    });

    describe('Expense Filter Injection', () => {
      it('should reject NoSQL injection in expense filters', async () => {
        const maliciousFilters = [
          { status: { $ne: null } },
          { reportId: { $regex: '.*' } },
          { $where: 'this.amount > 0' },
        ];

        for (const filter of maliciousFilters) {
          const response = await request(app)
            .get('/api/v1/expenses')
            .set('Authorization', `Bearer ${user1.token}`)
            .query(filter)
            .expect(400); // Should fail validation

          expect(response.body.success).toBe(false);
        }
      });
    });
  });

  describe('Mass Assignment Attacks', () => {
    describe('Profile Update Mass Assignment', () => {
      it('should reject role escalation in profile update', async () => {
        // Try to set role to SUPER_ADMIN
        const response = await request(app)
          .patch('/api/v1/users/me')
          .set('Authorization', `Bearer ${user1.token}`)
          .send({
            name: 'Updated Name',
            role: 'SUPER_ADMIN', // Should be rejected
          })
          .expect(400); // Should fail validation

        expect(response.body.success).toBe(false);
      });

      it('should reject companyId change in profile update', async () => {
        // Try to change companyId
        const response = await request(app)
          .patch('/api/v1/users/me')
          .set('Authorization', `Bearer ${user1.token}`)
          .send({
            name: 'Updated Name',
            companyId: company2Id, // Should be rejected
          })
          .expect(400); // Should fail validation

        expect(response.body.success).toBe(false);
      });

      it('should reject status change in profile update', async () => {
        // Try to change status
        const response = await request(app)
          .patch('/api/v1/users/me')
          .set('Authorization', `Bearer ${user1.token}`)
          .send({
            name: 'Updated Name',
            status: 'INACTIVE', // Should be rejected
          })
          .expect(400); // Should fail validation

        expect(response.body.success).toBe(false);
      });
    });

    describe('Expense Update Mass Assignment', () => {
      it('should reject userId change in expense update', async () => {
        // Try to change expense owner
        const response = await request(app)
          .patch(`/api/v1/expenses/${expense1._id}`)
          .set('Authorization', `Bearer ${user1.token}`)
          .send({
            amount: 200,
            userId: user2.id, // Should be rejected
          })
          .expect(400); // Should fail validation

        expect(response.body.success).toBe(false);
      });

      it('should reject reportId change in expense update', async () => {
        // Try to move expense to different report
        const report2 = await createTestReport(user1.id, company1Id);
        const response = await request(app)
          .patch(`/api/v1/expenses/${expense1._id}`)
          .set('Authorization', `Bearer ${user1.token}`)
          .send({
            amount: 200,
            reportId: report2._id.toString(), // Should be rejected or validated
          });

        // Should either fail validation or be rejected by business logic
        expect([400, 403]).toContain(response.status);
      });
    });
  });

  describe('IDOR (Insecure Direct Object Reference) Attacks', () => {
    describe('Expense IDOR', () => {
      it('should block access to other user\'s expense', async () => {
        // User2 tries to access user1's expense
        const response = await request(app)
          .get(`/api/v1/expenses/${expense1._id}`)
          .set('Authorization', `Bearer ${user2.token}`)
          .expect(404); // Should return 404 (not found) or 403 (forbidden)

        expect(response.body.success).toBe(false);
      });

      it('should block update of other user\'s expense', async () => {
        const response = await request(app)
          .patch(`/api/v1/expenses/${expense1._id}`)
          .set('Authorization', `Bearer ${user2.token}`)
          .send({ amount: 9999 })
          .expect(404); // Should return 404 or 403

        expect(response.body.success).toBe(false);
      });

      it('should block deletion of other user\'s expense', async () => {
        const response = await request(app)
          .delete(`/api/v1/expenses/${expense1._id}`)
          .set('Authorization', `Bearer ${user2.token}`)
          .expect(404); // Should return 404 or 403

        expect(response.body.success).toBe(false);
      });
    });

    describe('Report IDOR', () => {
      it('should block access to other user\'s report', async () => {
        // User2 tries to access user1's report
        const response = await request(app)
          .get(`/api/v1/reports/${report1._id}`)
          .set('Authorization', `Bearer ${user2.token}`)
          .expect(404); // Should return 404 or 403

        expect(response.body.success).toBe(false);
      });

      it('should block update of other user\'s report', async () => {
      const response = await request(app)
        .patch(`/api/v1/reports/${report1._id}`)
        .set('Authorization', `Bearer ${user2.token}`)
        .send({ name: 'Hacked Report' });

      // Should return 404 or 403 or 500 (depending on implementation)
      expect([404, 403, 500]).toContain(response.status);
      expect(response.body.success).toBe(false);
      });
    });

    describe('Cross-Company IDOR', () => {
      it('should block access to other company\'s data', async () => {
        // User1 from company1 tries to access user2's data (company2)
        const response = await request(app)
          .get(`/api/v1/users/${user2.id}`)
          .set('Authorization', `Bearer ${user1.token}`)
          .expect(403); // Should return 403 (forbidden) or 404

        expect(response.body.success).toBe(false);
      });

      it('should block listing other company\'s expenses', async () => {
        // Create expense for user2
        const report2 = await createTestReport(user2.id, company2Id);
        const category2 = await createTestCategory('Category 2', company2Id);
        const expense2 = await createTestExpense(
          user2.id,
          report2._id.toString(),
          category2._id.toString()
        );

        // User1 tries to list expenses - should only see their own
        const response = await request(app)
          .get('/api/v1/expenses')
          .set('Authorization', `Bearer ${user1.token}`)
          .expect(200);

        expect(response.body.success).toBe(true);
        // Verify user1's expenses don't include user2's expense
        if (response.body.data && Array.isArray(response.body.data)) {
          const expenseIds = response.body.data.map((e: any) => e._id?.toString());
          expect(expenseIds).not.toContain(expense2._id.toString());
        }
      });
    });

    describe('User Profile IDOR', () => {
      it('should block update of other user\'s profile', async () => {
        // User1 tries to update user2's profile
        const response = await request(app)
          .patch(`/api/v1/users/${user2.id}`)
          .set('Authorization', `Bearer ${user1.token}`)
          .send({ name: 'Hacked Name' })
          .expect(403); // Should return 403 (forbidden)

        expect(response.body.success).toBe(false);
      });
    });
  });

  describe('Path Traversal Attacks', () => {
    it('should reject path traversal in resource IDs', async () => {
      const maliciousIds = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        '%2e%2e%2f',
        '....//....//etc/passwd',
      ];

      for (const maliciousId of maliciousIds) {
        const response = await request(app)
          .get(`/api/v1/expenses/${maliciousId}`)
          .set('Authorization', `Bearer ${user1.token}`)
          .expect(404); // Should return 404 (not found) or 400 (bad request)

        expect(response.body.success).toBe(false);
      }
    });
  });

  describe('Object ID Validation', () => {
    it('should reject invalid MongoDB ObjectId format', async () => {
      const invalidIds = [
        'not-an-object-id',
        '123',
        'null',
        'undefined',
        '<script>alert("xss")</script>',
      ];

      for (const invalidId of invalidIds) {
        const response = await request(app)
          .get(`/api/v1/expenses/${invalidId}`)
          .set('Authorization', `Bearer ${user1.token}`)
          .expect(404); // Should return 404 or 400

        expect(response.body.success).toBe(false);
      }
    });
  });
});

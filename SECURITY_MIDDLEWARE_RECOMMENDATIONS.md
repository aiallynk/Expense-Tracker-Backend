# Security Middleware Recommendations

## Overview

This document provides security recommendations for enhancing the Nexpense backend security posture, addressing vulnerabilities identified through security testing and OWASP Top 10 compliance.

## Current Security Status

### Strengths
- JWT authentication with proper token validation
- Rate limiting implemented for login and API endpoints
- File upload validation (mimetype and size)
- Company-based access control for multi-tenant isolation
- Zod schema validation for request data

### Areas for Improvement
- No token blacklisting/revocation mechanism
- File upload validation relies only on mimetype (not magic bytes)
- Rate limits are very high (may allow brute force)
- No magic bytes validation for uploaded files
- No account lockout after failed login attempts

## Recommendations by Category

### 1. JWT Security Enhancements

#### 1.1 Token Blacklisting
**Priority**: High  
**OWASP Category**: A02:2021 – Cryptographic Failures

**Current Issue**: Tokens can be reused even after logout. There's no mechanism to revoke tokens.

**Recommendation**: Implement Redis-based token blacklist

```typescript
// src/middleware/tokenBlacklist.middleware.ts
import { Redis } from 'ioredis';
import { AuthRequest } from './auth.middleware';

const redis = new Redis(process.env.REDIS_URL);

export async function checkTokenBlacklist(token: string): Promise<boolean> {
  const jti = extractJti(token); // Extract JWT ID from token
  const blacklisted = await redis.get(`blacklist:${jti}`);
  return blacklisted !== null;
}

export async function blacklistToken(token: string, expiresIn: number): Promise<void> {
  const jti = extractJti(token);
  await redis.setex(`blacklist:${jti}`, expiresIn, '1');
}
```

**Implementation Steps**:
1. Add `jti` (JWT ID) to token payload during generation
2. Check blacklist in `auth.middleware.ts` before token validation
3. Add token to blacklist on logout
4. Set TTL equal to token expiration time

#### 1.2 Token Rotation
**Priority**: Medium  
**OWASP Category**: A02:2021 – Cryptographic Failures

**Recommendation**: Implement refresh token rotation

```typescript
// On refresh token use:
// 1. Invalidate old refresh token
// 2. Generate new refresh token
// 3. Return new token pair
```

**Benefits**:
- Prevents token reuse attacks
- Limits impact of token theft
- Enables token revocation

#### 1.3 Algorithm Whitelist
**Priority**: High  
**OWASP Category**: A02:2021 – Cryptographic Failures

**Current Issue**: JWT library may accept multiple algorithms.

**Recommendation**: Explicitly specify allowed algorithms

```typescript
// src/middleware/auth.middleware.ts
const decoded = jwt.verify(token, config.jwt.accessSecret, {
  algorithms: ['HS256'], // Explicitly allow only HS256
}) as JwtPayload;
```

#### 1.4 Token Binding
**Priority**: Medium  
**OWASP Category**: A02:2021 – Cryptographic Failures

**Recommendation**: Bind tokens to IP address or device fingerprint

```typescript
// Add to token payload:
{
  ip: req.ip,
  deviceFingerprint: generateDeviceFingerprint(req),
}

// Validate in middleware:
if (decoded.ip !== req.ip) {
  throw new Error('Token IP mismatch');
}
```

### 2. File Upload Security Enhancements

#### 2.1 Magic Bytes Validation
**Priority**: High  
**OWASP Category**: A05:2021 – Security Misconfiguration

**Current Issue**: Only mimetype is validated, not actual file content.

**Recommendation**: Validate file magic bytes

```typescript
// src/utils/fileValidation.ts
import { magicBytes } from './magicBytes';

export function validateFileMagicBytes(fileBuffer: Buffer, expectedType: string): boolean {
  const fileMagicBytes = fileBuffer.slice(0, 4);
  const expectedMagicBytes = magicBytes[expectedType];
  
  return fileMagicBytes.equals(expectedMagicBytes);
}

// Usage in controller:
if (!validateFileMagicBytes(fileBuffer, 'jpeg')) {
  throw new Error('File content does not match declared type');
}
```

**Magic Bytes Reference**:
- JPEG: `FF D8 FF E0`
- PNG: `89 50 4E 47`
- GIF: `47 49 46 38`

#### 2.2 File Content Scanning
**Priority**: Medium  
**OWASP Category**: A05:2021 – Security Misconfiguration

**Recommendation**: Scan uploaded files for malicious content

```typescript
// Options:
// 1. Use ClamAV for virus scanning
// 2. Use file-type library for content detection
// 3. Implement custom content validation
```

#### 2.3 Strict Filename Validation
**Priority**: Medium  
**OWASP Category**: A05:2021 – Security Misconfiguration

**Recommendation**: Sanitize and validate filenames

```typescript
export function sanitizeFilename(filename: string): string {
  // Remove path traversal
  const basename = path.basename(filename);
  
  // Remove special characters
  const sanitized = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  
  // Remove double extensions
  const parts = sanitized.split('.');
  if (parts.length > 2) {
    return `${parts[0]}.${parts[parts.length - 1]}`;
  }
  
  return sanitized;
}
```

#### 2.4 Quarantine Suspicious Files
**Priority**: Low  
**OWASP Category**: A05:2021 – Security Misconfiguration

**Recommendation**: Store suspicious files in quarantine before processing

```typescript
// Store in quarantine bucket
// Process after validation
// Move to production bucket only after approval
```

### 3. Rate Limiting Enhancements

#### 3.1 Progressive Delays
**Priority**: High  
**OWASP Category**: A07:2021 – Identification and Authentication Failures

**Current Issue**: Rate limits are very high (10K dev / 100K prod), allowing brute force.

**Recommendation**: Implement exponential backoff for failed logins

```typescript
// src/middleware/progressiveRateLimit.middleware.ts
export const progressiveLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Start with 5 attempts
  message: {
    success: false,
    message: 'Too many login attempts. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  // Custom handler for progressive delays
  handler: (req, res) => {
    const attempts = getFailedAttempts(req.ip);
    const delay = Math.min(attempts * 1000, 60000); // Max 60 seconds
    
    res.status(429).json({
      success: false,
      message: `Too many attempts. Please wait ${delay / 1000} seconds.`,
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: delay / 1000,
    });
  },
});
```

#### 3.2 Account Lockout
**Priority**: High  
**OWASP Category**: A07:2021 – Identification and Authentication Failures

**Recommendation**: Lock accounts after N failed attempts

```typescript
// src/middleware/accountLockout.middleware.ts
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION = 30 * 60 * 1000; // 30 minutes

export async function checkAccountLockout(email: string): Promise<boolean> {
  const key = `lockout:${email}`;
  const locked = await redis.get(key);
  return locked !== null;
}

export async function recordFailedAttempt(email: string): Promise<void> {
  const key = `failed:${email}`;
  const attempts = await redis.incr(key);
  await redis.expire(key, 15 * 60); // 15 minute window
  
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    await redis.setex(`lockout:${email}`, LOCKOUT_DURATION / 1000, '1');
  }
}
```

#### 3.3 CAPTCHA Integration
**Priority**: Medium  
**OWASP Category**: A07:2021 – Identification and Authentication Failures

**Recommendation**: Require CAPTCHA after rate limit threshold

```typescript
// After 3 failed attempts, require CAPTCHA
if (failedAttempts >= 3) {
  return res.status(429).json({
    success: false,
    message: 'CAPTCHA required',
    code: 'CAPTCHA_REQUIRED',
    captchaRequired: true,
  });
}
```

#### 3.4 Distributed Rate Limiting
**Priority**: Medium  
**OWASP Category**: A07:2021 – Identification and Authentication Failures

**Recommendation**: Use Redis for distributed rate limiting

```typescript
// Use Redis-based rate limiting for multi-server deployments
import { RateLimiterRedis } from 'rate-limiter-flexible';

const rateLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl',
  points: 5, // Number of requests
  duration: 15 * 60, // Per 15 minutes
});
```

### 4. IDOR Protection Enhancements

#### 4.1 Resource Ownership Validation Middleware
**Priority**: High  
**OWASP Category**: A01:2021 – Broken Access Control

**Recommendation**: Create reusable middleware for resource ownership

```typescript
// src/middleware/resourceOwnership.middleware.ts
export function validateResourceOwnership(
  resourceType: 'expense' | 'report' | 'receipt',
  resourceIdParam: string = 'id'
) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const resourceId = req.params[resourceIdParam];
    const userId = req.user!.id;
    const userRole = req.user!.role;
    
    // Check ownership based on resource type
    const hasAccess = await checkResourceAccess(resourceType, resourceId, userId, userRole);
    
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
        code: 'FORBIDDEN',
      });
    }
    
    next();
  };
}
```

#### 4.2 Company Access Middleware
**Priority**: High  
**OWASP Category**: A01:2021 – Broken Access Control

**Recommendation**: Enhance existing company access middleware

```typescript
// Enhance src/utils/companyAccess.ts
export async function validateCompanyAccessMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const resourceCompanyId = await getResourceCompanyId(req);
  
  if (!resourceCompanyId) {
    return res.status(404).json({
      success: false,
      message: 'Resource not found',
      code: 'NOT_FOUND',
    });
  }
  
  const hasAccess = await validateCompanyAccess(req, resourceCompanyId);
  
  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      message: 'Access denied',
      code: 'FORBIDDEN',
    });
  }
  
  next();
}
```

#### 4.3 Audit Logging
**Priority**: Medium  
**OWASP Category**: A09:2021 – Security Logging and Monitoring Failures

**Recommendation**: Log all access attempts for security monitoring

```typescript
// src/middleware/auditLog.middleware.ts
export function auditLogMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const auditEntry = {
    userId: req.user?.id,
    ip: req.ip,
    method: req.method,
    path: req.path,
    timestamp: new Date(),
    statusCode: res.statusCode,
  };
  
  // Log to audit service
  AuditService.logAccess(auditEntry);
  
  next();
}
```

### 5. NoSQL Injection Protection

#### 5.1 Input Sanitization
**Priority**: High  
**OWASP Category**: A03:2021 – Injection

**Current Status**: Zod schemas provide some protection, but need to ensure all inputs are validated.

**Recommendation**: Add explicit NoSQL injection sanitization

```typescript
// src/utils/sanitize.ts
export function sanitizeInput(input: any): any {
  if (typeof input === 'object' && input !== null) {
    // Remove MongoDB operators
    const dangerousKeys = ['$where', '$ne', '$gt', '$lt', '$regex', '$or', '$and'];
    for (const key of dangerousKeys) {
      if (key in input) {
        throw new Error(`Dangerous operator detected: ${key}`);
      }
    }
    
    // Recursively sanitize nested objects
    const sanitized: any = {};
    for (const [key, value] of Object.entries(input)) {
      sanitized[key] = sanitizeInput(value);
    }
    return sanitized;
  }
  
  return input;
}
```

### 6. Mass Assignment Protection

#### 6.1 Field Whitelisting
**Priority**: High  
**OWASP Category**: A04:2021 – Insecure Design

**Current Status**: Zod schemas provide field validation, but need to ensure all endpoints use strict schemas.

**Recommendation**: Ensure all update endpoints use strict field whitelisting

```typescript
// Example: Profile update should only allow specific fields
export const updateProfileSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  profileImage: z.string().url().optional().nullable(),
  // Explicitly exclude: role, companyId, status, etc.
}).strict(); // Use .strict() to reject unknown fields
```

## Implementation Priority

### High Priority (Implement First)
1. Magic bytes validation for file uploads
2. Account lockout after failed login attempts
3. Resource ownership validation middleware
4. NoSQL injection sanitization
5. Algorithm whitelist for JWT

### Medium Priority
1. Token blacklisting
2. Progressive rate limiting
3. Token rotation
4. CAPTCHA integration
5. Audit logging

### Low Priority
1. Token binding
2. File content scanning
3. Quarantine for suspicious files
4. Distributed rate limiting (if multi-server)

## Testing

All security enhancements should be tested using the security test suite:
- `npm run test:security` - Run all security tests
- `npm run test:security:jwt` - JWT security tests
- `npm run test:security:api` - API security tests
- `npm run test:security:upload` - File upload security tests
- `npm run test:security:rate` - Rate limiting tests

## Monitoring

Implement security monitoring for:
- Failed login attempts
- Rate limit triggers
- Token blacklist usage
- File upload rejections
- IDOR access attempts
- NoSQL injection attempts

## References

- [OWASP Top 10 2021](https://owasp.org/Top10/)
- [OWASP JWT Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [OWASP Rate Limiting Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Rate_Limiting_Cheat_Sheet.html)

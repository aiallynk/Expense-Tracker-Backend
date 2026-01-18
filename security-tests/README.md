# Security Test Suite

## Overview

Automated security tests covering OWASP Top 10 vulnerabilities for the Nexpense backend.

## Test Files

### 1. JWT Attacks (`jwtAttacks.test.ts`)
Tests JWT token security:
- Token tampering (payload modification, signature tampering)
- Algorithm confusion attacks (none algorithm)
- Token reuse scenarios
- Expired token handling
- Malformed token attacks
- Token secret brute force

**Expected Results**: All attacks should FAIL (security working correctly)

### 2. API Attacks (`apiAttacks.test.ts`)
Tests API security vulnerabilities:
- NoSQL injection in query parameters and request body
- Mass assignment vulnerabilities
- IDOR (Insecure Direct Object Reference) attacks
- Path traversal attacks
- Object ID validation

**Expected Results**: All attacks should FAIL (security working correctly)

### 3. File Upload Attacks (`fileUploadAttacks.test.ts`)
Tests file upload security:
- Malicious files disguised as images (PHP, JS, HTML, executables)
- Double extension attacks
- Magic bytes validation
- File size attacks
- Filename injection (null bytes, path traversal)
- MIME type spoofing

**Expected Results**: All attacks should FAIL (security working correctly)

### 4. Rate Limiting (`rateLimiting.test.ts`)
Tests rate limiting security:
- Brute force login attempts
- Rate limit bypass attempts (IP header manipulation)
- Distributed attack simulation
- Rate limit headers
- Concurrent rate limit attacks

**Expected Results**: Rate limits should trigger correctly

## Running Tests

```bash
# Run all security tests
npm run test:security

# Run specific test suite
npm run test:security:jwt      # JWT attacks
npm run test:security:api      # API attacks
npm run test:security:upload   # File upload attacks
npm run test:security:rate      # Rate limiting
```

## Test Results Interpretation

### PASS
- **JWT Attacks**: Security is working - attacks are properly rejected
- **API Attacks**: Security is working - attacks are properly rejected
- **File Upload Attacks**: Security is working - attacks are properly rejected
- **Rate Limiting**: Rate limits are working correctly

### FAIL
- **JWT Attacks**: Security vulnerability detected - token validation may be insufficient
- **API Attacks**: Security vulnerability detected - injection/IDOR protection may be insufficient
- **File Upload Attacks**: Security vulnerability detected - file validation may be insufficient
- **Rate Limiting**: Rate limiting may not be working correctly

## Security Recommendations

See `SECURITY_MIDDLEWARE_RECOMMENDATIONS.md` for detailed security enhancement recommendations.

## OWASP Top 10 Coverage

- **A01:2021 – Broken Access Control**: IDOR tests
- **A02:2021 – Cryptographic Failures**: JWT tests
- **A03:2021 – Injection**: NoSQL injection tests
- **A04:2021 – Insecure Design**: Mass assignment tests
- **A05:2021 – Security Misconfiguration**: File upload tests
- **A07:2021 – Identification and Authentication Failures**: Rate limiting tests

## Notes

- Tests use isolated test database (MongoMemoryServer)
- All tests are independent and can run in any order
- Tests follow OWASP testing methodology
- Clear PASS/FAIL output with security violation details

# Nexpense Backend Test Suite

Complete automation testing suite using Jest + Supertest for the Nexpense backend API.

## Overview

This test suite provides comprehensive coverage for:
- **Authentication**: Login, invalid credentials, deactivated users, token expiration
- **Authorization (RBAC)**: Role-based access control, cross-company data isolation
- **Expense APIs**: CRUD operations, category constraints, pagination
- **Concurrency**: 1000 parallel requests, atomicity verification
- **Profile Image Upload**: File validation, S3 mocking, old image deletion

## Prerequisites

- Node.js >= 18.0.0
- MongoDB (in-memory via mongodb-memory-server for tests)
- All dependencies installed (`npm install`)

## Installation

```bash
# Install dependencies (Jest, Supertest, etc.)
npm install
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Test Structure

```
tests/
├── setup.ts                 # Global test setup (DB connection, cleanup)
├── utils/
│   ├── testHelpers.ts       # Helper functions for creating test data
│   └── s3Mock.ts            # AWS S3 mocking utilities
├── auth.test.ts             # Authentication tests
├── authorization.test.ts    # RBAC and authorization tests
├── expenses.test.ts         # Expense API tests
├── concurrency.test.ts      # Concurrency and race condition tests
└── profileImage.test.ts     # Profile image upload tests
```

## Test Coverage

### 1. Authentication Tests (`auth.test.ts`)

- ✅ Login with valid credentials
- ✅ Login with invalid password
- ✅ Login with non-existent email
- ✅ Login with deactivated user (User)
- ✅ Login with deactivated company admin
- ✅ Token expiration handling
- ✅ Invalid token format
- ✅ Missing authentication

### 2. Authorization Tests (`authorization.test.ts`)

- ✅ Employee access control (own data only)
- ✅ Employee blocked from company admin APIs
- ✅ Employee blocked from super admin APIs
- ✅ Company admin access to company admin APIs
- ✅ Company admin blocked from super admin APIs
- ✅ Cross-company data isolation
- ✅ Super admin full access

### 3. Expense API Tests (`expenses.test.ts`)

- ✅ Create expense successfully
- ✅ Reject expense creation with invalid report ID
- ✅ Reject expense creation without required fields
- ✅ Update expense successfully
- ✅ Reject update with invalid expense ID
- ✅ Delete expense successfully
- ✅ Block category deletion if linked to expenses
- ✅ Allow category deletion if not linked
- ✅ Pagination (page, limit, total)
- ✅ Filter by date range
- ✅ Filter by category

### 4. Concurrency Tests (`concurrency.test.ts`)

- ✅ Handle 1000 parallel expense creation requests
- ✅ No duplicate expenses created
- ✅ Atomic DB writes maintained
- ✅ Concurrent report generation
- ✅ Race condition prevention (duplicate detection)

### 5. Profile Image Upload Tests (`profileImage.test.ts`)

- ✅ Reject invalid file type (non-image)
- ✅ Reject file larger than 5MB
- ✅ Successfully upload valid JPEG
- ✅ Successfully upload valid PNG
- ✅ Require authentication
- ✅ Update profile image (replace existing)

## Test Database

Tests use **MongoDB Memory Server** - an in-memory MongoDB instance that:
- ✅ Starts automatically before tests
- ✅ Cleans up after each test (no data persistence)
- ✅ Is completely isolated from production/development databases
- ✅ Requires no external MongoDB setup

## Mocking

### AWS S3 Mocking

The test suite includes a complete S3 mock (`tests/utils/s3Mock.ts`) that:
- ✅ Simulates S3 uploads/downloads in memory
- ✅ Validates file operations without AWS credentials
- ✅ Cleans up after each test
- ✅ Verifies old image deletion logic

## Environment Variables

Tests use a minimal `.env` configuration. Required variables:
- `JWT_ACCESS_SECRET`: For token generation (can be any string in tests)
- `JWT_REFRESH_SECRET`: For refresh tokens (can be any string in tests)
- `MONGODB_URI`: Not required (uses in-memory DB)

## Best Practices

1. **Isolation**: Each test is completely isolated - no shared state
2. **Cleanup**: Database is cleared after each test
3. **No Hardcoded Secrets**: All secrets come from environment or test helpers
4. **Realistic Data**: Test helpers create realistic test data
5. **Comprehensive Assertions**: Tests verify both success and error cases

## Troubleshooting

### Tests Failing with "Cannot find module"

```bash
# Rebuild TypeScript
npm run build

# Or run tests with ts-jest (handles TS compilation)
npm test
```

### MongoDB Memory Server Issues

If you see MongoDB connection errors:
- Ensure you have sufficient memory (MongoDB Memory Server uses ~200MB)
- Check that no other MongoDB instance is using the same port

### S3 Mock Issues

If S3-related tests fail:
- Ensure `mockS3Client()` is called in `beforeAll`
- Check that `resetS3Mocks()` is called in `afterEach`

## CI/CD Integration

These tests are designed to run in CI/CD pipelines:
- ✅ No external dependencies (uses in-memory DB)
- ✅ Fast execution (< 2 minutes for full suite)
- ✅ Deterministic results (no flaky tests)
- ✅ Zero configuration required

## Coverage Goals

- **Target**: 80%+ code coverage
- **Critical Paths**: 100% coverage (auth, expenses, RBAC)
- **Run**: `npm run test:coverage` to see current coverage

## Contributing

When adding new tests:
1. Follow existing test structure
2. Use test helpers from `utils/testHelpers.ts`
3. Mock external services (S3, etc.)
4. Clean up test data in `afterEach`
5. Add descriptive test names
6. Include both success and error cases

## Notes

- Tests run serially (`maxWorkers: 1`) to avoid DB conflicts
- Test timeout is 30 seconds (increased to 60s for concurrency tests)
- All tests use isolated in-memory database
- No real AWS S3 calls are made during tests

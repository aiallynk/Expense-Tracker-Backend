/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Increase default timeout so MongoMemoryServer setup/teardown has enough time
  testTimeout: 30000,

  // Pick up TypeScript test files (exclude src/tests - e.g. gemini.local.test.ts runs process.exit)
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/security-tests/**/*.test.ts',
  ],

  // Global setup/teardown for regular tests (MongoMemoryServer, S3 mocks, etc.)
  // NOTE: Security tests use their own setup via CLI flags in package.json.
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],

  // Support path aliases like "@/..."
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // Use ts-jest to transform TypeScript (tests + src) for Jest
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },

  // Ignore built output and load-test artifacts
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/load-tests/'],
};


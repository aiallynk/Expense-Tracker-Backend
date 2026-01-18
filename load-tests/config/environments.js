/**
 * Environment configurations for k6 load tests
 * 
 * Usage:
 *   k6 run --env ENV=local scenarios/01-concurrent-logins.js
 *   k6 run --env ENV=staging scenarios/01-concurrent-logins.js
 *   k6 run --env ENV=production scenarios/01-concurrent-logins.js
 */

const environments = {
  local: {
    baseUrl: __ENV.BASE_URL || 'http://localhost:4000',
    timeout: '30s',
    testUsers: {
      prefix: 'loadtest',
      count: 100000,
      passwordPattern: 'TestPassword{index}!',
    },
    rateLimiting: {
      enabled: false,
    },
  },
  
  staging: {
    baseUrl: __ENV.BASE_URL || 'https://staging.nexpense.com',
    timeout: '30s',
    testUsers: {
      prefix: 'loadtest',
      count: 100000,
      passwordPattern: 'TestPassword{index}!',
    },
    rateLimiting: {
      enabled: true,
      maxRequestsPerSecond: 10000,
    },
  },
  
  production: {
    baseUrl: __ENV.BASE_URL || 'https://api.nexpense.com',
    timeout: '30s',
    testUsers: {
      prefix: 'loadtest',
      count: 100000,
      passwordPattern: 'TestPassword{index}!',
    },
    rateLimiting: {
      enabled: true,
      maxRequestsPerSecond: 10000,
    },
  },
};

// Get environment from ENV variable or default to local
const envName = __ENV.ENV || 'local';
const config = environments[envName] || environments.local;

// Export configuration
export default config;

// Export base URL for convenience
export const BASE_URL = config.baseUrl;
export const TIMEOUT = config.timeout;

/**
 * Scenario 1: Concurrent Logins
 * 
 * Target: 100,000 concurrent virtual users
 * Duration: Ramp-up to 100k VUs over 5 minutes, hold for 2 minutes
 * Endpoint: POST /api/v1/auth/login
 * 
 * Assertions:
 * - Error rate < 0.1%
 * - Response time p95 < 300ms
 * - Response time p99 < 500ms
 * - All logins return 200 status
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { login } from '../lib/auth.js';
import { standardThresholds } from '../config/thresholds.js';
import config from '../config/environments.js';

// Custom metrics
const authSuccessRate = new Rate('auth_success');

// Test options
export const options = {
  thresholds: {
    ...standardThresholds,
    'auth_success': ['rate>0.999'],
  },
  
  scenarios: {
    concurrent_logins: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5m', target: 100000 }, // Ramp up to 100k VUs over 5 minutes
        { duration: '2m', target: 100000 }, // Hold at 100k VUs for 2 minutes
      ],
      gracefulRampDown: '30s',
    },
  },
};

// Load test users from file or generate on the fly
let testUsers = [];

// Setup: Load test users
export function setup() {
  const baseUrl = config.baseUrl;
  
  // Use existing credentials - cycle through them for high concurrency
  const baseUsers = [
    { email: 'example@sa.com', password: 'password123' },
    { email: 'tushar@thukk.com', password: '111111' },
    { email: 'admin@thukk.com', password: '111111' },
  ];
  
  // For 100k concurrent users, we'll cycle through the 3 base users
  // Each user will be used multiple times (realistic for load testing)
  for (let i = 0; i < 100000; i++) {
    testUsers.push(baseUsers[i % baseUsers.length]);
  }
  
  console.log(`Using ${baseUsers.length} base users cycled for ${testUsers.length} concurrent logins`);
  
  return { testUsers };
}

// Main test function
export default function (data) {
  const baseUrl = config.baseUrl;
  const testUsers = data.testUsers;
  
  // Select a random user
  const userIndex = Math.floor(Math.random() * testUsers.length);
  const user = testUsers[userIndex];
  
  // Perform login
  const authResult = login(baseUrl, user.email, user.password);
  
  // Check if login was successful
  const success = check(authResult, {
    'login successful': (result) => result !== null && result.accessToken !== undefined,
    'access token present': (result) => result !== null && result.accessToken && result.accessToken.length > 0,
    'refresh token present': (result) => result !== null && result.refreshToken && result.refreshToken.length > 0,
  });
  
  authSuccessRate.add(success);
  
  // Small sleep to avoid hammering the server
  sleep(0.1);
}

// Teardown (optional)
export function teardown(data) {
  console.log('Concurrent logins test completed');
}

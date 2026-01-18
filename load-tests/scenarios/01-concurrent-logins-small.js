/**
 * Small Scale Concurrent Logins Test
 * 
 * Reduced version for initial testing
 * Target: 10 concurrent virtual users
 * Duration: 30 seconds
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { login } from '../lib/auth.js';
import { combinedThresholds } from '../config/thresholds.js';
import config from '../config/environments.js';

// Custom metrics
const authSuccessRate = new Rate('auth_success');

// Test options - Small scale
export const options = {
  thresholds: {
    'http_req_failed': ['rate<0.2'], // Relaxed for small test
    'http_req_duration': ['p(95)<500'], // Relaxed
  },
  
  scenarios: {
    concurrent_logins: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 10 }, // Ramp to 10 VUs
        { duration: '20s', target: 10 }, // Hold at 10 VUs
      ],
      gracefulRampDown: '5s',
    },
  },
};

// Use existing credentials
const baseUsers = [
  { email: 'example@sa.com', password: 'password123' },
  { email: 'tushar@thukk.com', password: '111111' },
  { email: 'admin@thukk.com', password: '111111' },
];

// Setup
export function setup() {
  const testUsers = [];
  // Cycle through base users
  for (let i = 0; i < 10; i++) {
    testUsers.push(baseUsers[i % baseUsers.length]);
  }
  return { testUsers };
}

// Main test function
export default function (data) {
  const baseUrl = config.baseUrl;
  const testUsers = data.testUsers;
  
  // Select a random user
  const userIndex = Math.floor(Math.random() * testUsers.length);
  const user = testUsers[userIndex];
  
  // Perform login with direct HTTP call to see status
  const loginResponse = http.post(`${baseUrl}/api/v1/auth/login`, JSON.stringify({
    email: user.email,
    password: user.password,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  let authResult = null;
  if (loginResponse.status === 200) {
    try {
      const body = JSON.parse(loginResponse.body);
      if (body.success && body.data && body.data.tokens) {
        authResult = {
          accessToken: body.data.tokens.accessToken,
          refreshToken: body.data.tokens.refreshToken,
        };
      }
    } catch (e) {
      // Parse error
    }
  }
  
  // Check response
  const success = check(loginResponse, {
    'status is 200': (r) => r.status === 200,
    'not rate limited': (r) => r.status !== 429,
  }) && check(authResult, {
    'login successful': (result) => result !== null,
    'access token present': (result) => result !== null && result.accessToken !== undefined,
  });
  
  // Log first few failures for debugging
  if (!success && __VU <= 2 && __ITER <= 2) {
    console.log(`VU ${__VU} Iter ${__ITER}: Status ${loginResponse.status}, Body: ${loginResponse.body.substring(0, 150)}`);
  }
  
  authSuccessRate.add(success);
  
  // Sleep to avoid rate limiting
  sleep(2);
}

// Teardown
export function teardown(data) {
  console.log('Small concurrent logins test completed');
}

/**
 * Validation Test - Quick test to verify setup
 * 
 * This is a small test to verify:
 * - k6 is working
 * - API is accessible
 * - Test users can authenticate
 * 
 * Run this before running full-scale tests
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { login } from '../lib/auth.js';
import config from '../config/environments.js';

export const options = {
  vus: 5, // Only 5 virtual users for validation
  duration: '10s', // 10 seconds
  thresholds: {
    'http_req_duration': ['p(95)<1000'], // Relaxed for validation
    'http_req_failed': ['rate<0.1'], // Less than 10% failures
  },
};

export default function () {
  const baseUrl = config.baseUrl;
  
  // Test 1: Health check (if available)
  const healthCheck = http.get(`${baseUrl}/health`);
  check(healthCheck, {
    'health check status': (r) => r.status === 200 || r.status === 404, // 404 is OK if endpoint doesn't exist
  });
  
  // Test 2: Login with existing test users
  const testUsers = [
    { email: 'example@sa.com', password: 'password123', role: 'Super Admin' },
    { email: 'tushar@thukk.com', password: '111111', role: 'Employee' },
    { email: 'admin@thukk.com', password: '111111', role: 'Company Admin' },
  ];
  
  // Test with a random user from the list
  const testUser = testUsers[Math.floor(Math.random() * testUsers.length)];
  
  // Direct login call to see response details
  const loginResponse = http.post(`${baseUrl}/api/v1/auth/login`, JSON.stringify({
    email: testUser.email,
    password: testUser.password,
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
  
  check(loginResponse, {
    'login status is 200 or 429': (r) => r.status === 200 || r.status === 429, // 429 = rate limited
    'login response received': (r) => r.status !== undefined,
  });
  
  check(authResult, {
    'login successful': (result) => result !== null,
    'access token present': (result) => result !== null && result.accessToken !== undefined,
  });
  
  // Log error if login failed
  if (loginResponse.status !== 200 && loginResponse.status !== 429) {
    console.log(`Login failed: Status ${loginResponse.status}, Body: ${loginResponse.body.substring(0, 200)}`);
  }
  
  sleep(1);
}

// Summary will be printed automatically by k6

/**
 * Scenario 2: Expense Creation
 * 
 * Target: 500,000 requests per minute (8,333 RPS)
 * Duration: 1 minute constant rate
 * Endpoint: POST /api/v1/reports/:reportId/expenses
 * 
 * Prerequisites:
 * - Authenticated users (token from login)
 * - Existing expense reports (created in setup or via API)
 * 
 * Assertions:
 * - Error rate < 0.1%
 * - Response time p95 < 300ms
 * - All creations return 201 status
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { login, getAuthHeaders } from '../lib/auth.js';
import { generateExpenseData } from '../lib/data.js';
import { getRandomReportId, createTestReport } from '../lib/data.js';
import { standardThresholds } from '../config/thresholds.js';
import config from '../config/environments.js';

// Custom metrics
const expenseCreationSuccessRate = new Rate('expense_creation_success');

// Test options
export const options = {
  thresholds: {
    ...standardThresholds,
    'expense_creation_success': ['rate>0.999'],
  },
  
  scenarios: {
    expense_creation: {
      executor: 'constant-arrival-rate',
      rate: 8333, // 500k per minute = 8333 RPS
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 1000, // Pre-allocate VUs
      maxVUs: 10000, // Maximum VUs to use
    },
  },
};

// Setup: Authenticate users and create reports
export function setup() {
  const baseUrl = config.baseUrl;
  const testUsers = [];
  const userReports = new Map(); // Map of user email to report IDs
  
  // Use existing test users
  const baseUsers = [
    { email: 'tushar@thukk.com', password: '111111' }, // Employee - can create expenses
    { email: 'admin@thukk.com', password: '111111' }, // Company Admin
  ];
  
  // Cycle through base users for multiple authenticated sessions
  for (let i = 0; i < 1000; i++) {
    testUsers.push(baseUsers[i % baseUsers.length]);
  }
  
  console.log(`Using ${baseUsers.length} base users for expense creation test`);
  
  // Authenticate each user and create a report
  console.log(`Authenticating ${testUsers.length} users and creating reports...`);
  let authenticatedCount = 0;
  
  for (const user of testUsers) {
    const authResult = login(baseUrl, user.email, user.password);
    if (authResult && authResult.accessToken) {
      const headers = getAuthHeaders(authResult.accessToken);
      const reportId = createTestReport(baseUrl, headers);
      
      if (reportId) {
        userReports.set(user.email, {
          accessToken: authResult.accessToken,
          reportId: reportId,
        });
        authenticatedCount++;
      }
    }
    
    // Rate limit setup requests
    if (authenticatedCount % 100 === 0) {
      sleep(0.1);
    }
  }
  
  console.log(`Setup complete: ${authenticatedCount} users authenticated with reports`);
  
  return {
    baseUrl,
    userReports: Array.from(userReports.entries()),
  };
}

// Main test function
export default function (data) {
  const baseUrl = data.baseUrl;
  const userReports = data.userReports;
  
  if (userReports.length === 0) {
    console.error('No authenticated users with reports available');
    return;
  }
  
  // Select a random user with report
  const randomIndex = Math.floor(Math.random() * userReports.length);
  const [email, userData] = userReports[randomIndex];
  
  const headers = getAuthHeaders(userData.accessToken);
  const expenseData = generateExpenseData();
  
  // Create expense
  const response = http.post(
    `${baseUrl}/api/v1/reports/${userData.reportId}/expenses`,
    JSON.stringify(expenseData),
    { headers: headers }
  );
  
  // Check response
  const success = check(response, {
    'expense creation status is 201': (r) => r.status === 201,
    'expense creation response has data': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true && body.data !== undefined;
      } catch (e) {
        return false;
      }
    },
  });
  
  expenseCreationSuccessRate.add(success);
  
  // Small sleep to avoid hammering
  sleep(0.01);
}

// Teardown
export function teardown(data) {
  console.log('Expense creation test completed');
}

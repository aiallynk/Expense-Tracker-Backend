/**
 * Scenario 4: Spike Test
 * 
 * Target: Sudden 10x increase in traffic
 * Duration:
 *   - Baseline: 1k VUs for 2 minutes
 *   - Spike: 10k VUs for 1 minute
 *   - Recovery: Back to 1k VUs for 2 minutes
 * 
 * Endpoints: Mixed workload (login, expense creation, report fetch)
 * 
 * Assertions:
 * - Error rate < 0.1% (even during spike)
 * - Response time p95 < 500ms (relaxed during spike)
 * - System recovers within 30 seconds after spike
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { login, getAuthHeaders } from '../lib/auth.js';
import { generateExpenseData, getRandomReportId } from '../lib/data.js';
import { relaxedThresholds } from '../config/thresholds.js';
import config from '../config/environments.js';

// Custom metrics
const mixedWorkloadSuccessRate = new Rate('mixed_workload_success');

// Test options
export const options = {
  thresholds: {
    ...relaxedThresholds,
    'mixed_workload_success': ['rate>0.999'],
  },
  
  scenarios: {
    spike_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 1000 }, // Ramp to baseline
        { duration: '2m', target: 1000 },   // Baseline: 1k VUs for 2 minutes
        { duration: '10s', target: 10000 }, // Spike: Ramp to 10k VUs in 10 seconds
        { duration: '1m', target: 10000 },  // Hold spike: 10k VUs for 1 minute
        { duration: '30s', target: 1000 },  // Recovery: Back to 1k VUs in 30 seconds
        { duration: '2m', target: 1000 },   // Hold recovery: 1k VUs for 2 minutes
      ],
      gracefulRampDown: '30s',
    },
  },
};

// Setup: Prepare test data
export function setup() {
  const baseUrl = config.baseUrl;
  const testUsers = [];
  const userReports = [];
  
  // Use existing test users - cycle for high concurrency
  const baseUsers = [
    { email: 'example@sa.com', password: 'password123' },
    { email: 'tushar@thukk.com', password: '111111' },
    { email: 'admin@thukk.com', password: '111111' },
  ];
  
  // Cycle through base users for spike test
  for (let i = 0; i < 10000; i++) {
    testUsers.push(baseUsers[i % baseUsers.length]);
  }
  
  console.log(`Using ${baseUsers.length} base users cycled for spike test`);
  
  // Pre-authenticate a subset of users for expense/report operations
  console.log('Pre-authenticating users for mixed workload...');
  let authenticatedCount = 0;
  
  for (let i = 0; i < Math.min(1000, testUsers.length); i++) {
    const user = testUsers[i];
    const authResult = login(baseUrl, user.email, user.password);
    if (authResult && authResult.accessToken) {
      const headers = getAuthHeaders(authResult.accessToken);
      
      // Fetch user's reports
      const response = http.get(`${baseUrl}/api/v1/reports`, {
        headers: headers,
        params: { page: 1, pageSize: 10 },
      });
      
      if (response.status === 200) {
        try {
          const body = JSON.parse(response.body);
          if (body.success && body.data && body.data.length > 0) {
            const reportIds = body.data.map(r => r._id || r.id);
            userReports.push({
              email: user.email,
              accessToken: authResult.accessToken,
              reportIds: reportIds,
            });
            authenticatedCount++;
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
    
    if (authenticatedCount % 100 === 0) {
      sleep(0.1);
    }
  }
  
  console.log(`Setup complete: ${testUsers.length} test users, ${authenticatedCount} pre-authenticated`);
  
  return {
    baseUrl,
    testUsers,
    userReports,
  };
}

// Main test function - mixed workload
export default function (data) {
  const baseUrl = data.baseUrl;
  const testUsers = data.testUsers;
  const userReports = data.userReports;
  
  // Randomly choose an operation: 30% login, 35% expense creation, 35% report fetch
  const operation = Math.random();
  
  if (operation < 0.3) {
    // Login operation (30%)
    const userIndex = Math.floor(Math.random() * testUsers.length);
    const user = testUsers[userIndex];
    const authResult = login(baseUrl, user.email, user.password);
    
    const success = check(authResult, {
      'login successful': (result) => result !== null && result.accessToken !== undefined,
    });
    
    mixedWorkloadSuccessRate.add(success);
    
  } else if (operation < 0.65 && userReports.length > 0) {
    // Expense creation (35%)
    const randomUserIndex = Math.floor(Math.random() * userReports.length);
    const user = userReports[randomUserIndex];
    
    if (user.reportIds.length > 0) {
      const reportId = user.reportIds[Math.floor(Math.random() * user.reportIds.length)];
      const headers = getAuthHeaders(user.accessToken);
      const expenseData = generateExpenseData();
      
      const response = http.post(
        `${baseUrl}/api/v1/reports/${reportId}/expenses`,
        JSON.stringify(expenseData),
        { headers: headers }
      );
      
      const success = check(response, {
        'expense creation status is 201': (r) => r.status === 201,
      });
      
      mixedWorkloadSuccessRate.add(success);
    }
    
  } else if (userReports.length > 0) {
    // Report fetch (35%)
    const randomUserIndex = Math.floor(Math.random() * userReports.length);
    const user = userReports[randomUserIndex];
    
    if (user.reportIds.length > 0) {
      const reportId = user.reportIds[Math.floor(Math.random() * user.reportIds.length)];
      const headers = getAuthHeaders(user.accessToken);
      
      const response = http.get(`${baseUrl}/api/v1/reports/${reportId}`, { headers });
      
      const success = check(response, {
        'report fetch status is 200': (r) => r.status === 200,
      });
      
      mixedWorkloadSuccessRate.add(success);
    }
  }
  
  // Small sleep
  sleep(0.1);
}

// Teardown
export function teardown(data) {
  console.log('Spike test completed');
}

/**
 * Scenario 5: Soak Test
 * 
 * Target: Sustained moderate load for 24 hours
 * Duration: 24 hours
 * Load: 500 VUs constant, mixed workload
 * 
 * Endpoints: All endpoints (login, expense creation, report fetch)
 * 
 * Assertions:
 * - Error rate < 0.1% throughout
 * - Response time p95 < 300ms throughout
 * - No memory leak (monitor via external tools)
 * - No DB connection exhaustion (monitor via external tools)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { login, getAuthHeaders } from '../lib/auth.js';
import { generateExpenseData } from '../lib/data.js';
import { standardThresholds } from '../config/thresholds.js';
import config from '../config/environments.js';

// Custom metrics
const soakTestSuccessRate = new Rate('soak_test_success');

// Test options
export const options = {
  thresholds: {
    ...standardThresholds,
    'soak_test_success': ['rate>0.999'],
  },
  
  scenarios: {
    soak_test: {
      executor: 'constant-vus',
      vus: 500, // 500 constant virtual users
      duration: '24h', // 24 hours
    },
  },
};

// Setup: Prepare test data
export function setup() {
  const baseUrl = config.baseUrl;
  const testUsers = [];
  const userReports = [];
  
  // Use existing test users
  const baseUsers = [
    { email: 'example@sa.com', password: 'password123' },
    { email: 'tushar@thukk.com', password: '111111' },
    { email: 'admin@thukk.com', password: '111111' },
  ];
  
  // Cycle through base users for soak test
  for (let i = 0; i < 1000; i++) {
    testUsers.push(baseUsers[i % baseUsers.length]);
  }
  
  console.log(`Using ${baseUsers.length} base users for soak test`);
  
  // Pre-authenticate users for expense/report operations
  console.log('Pre-authenticating users for soak test...');
  let authenticatedCount = 0;
  
  for (let i = 0; i < Math.min(500, testUsers.length); i++) {
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
          } else {
            // Create a report if user has none
            const reportResponse = http.post(`${baseUrl}/api/v1/reports`, JSON.stringify({
              name: `Soak Test Report ${Date.now()}`,
            }), { headers });
            
            if (reportResponse.status === 201) {
              const reportBody = JSON.parse(reportResponse.body);
              if (reportBody.success && reportBody.data) {
                const reportId = reportBody.data._id || reportBody.data.id;
                userReports.push({
                  email: user.email,
                  accessToken: authResult.accessToken,
                  reportIds: [reportId],
                });
                authenticatedCount++;
              }
            }
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
  
  // Randomly choose an operation: 20% login, 40% expense creation, 40% report fetch
  const operation = Math.random();
  
  if (operation < 0.2) {
    // Login operation (20%)
    const userIndex = Math.floor(Math.random() * testUsers.length);
    const user = testUsers[userIndex];
    const authResult = login(baseUrl, user.email, user.password);
    
    const success = check(authResult, {
      'login successful': (result) => result !== null && result.accessToken !== undefined,
    });
    
    soakTestSuccessRate.add(success);
    
  } else if (operation < 0.6 && userReports.length > 0) {
    // Expense creation (40%)
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
      
      soakTestSuccessRate.add(success);
    }
    
  } else if (userReports.length > 0) {
    // Report fetch (40%)
    const randomUserIndex = Math.floor(Math.random() * userReports.length);
    const user = userReports[randomUserIndex];
    
    if (user.reportIds.length > 0) {
      const reportId = user.reportIds[Math.floor(Math.random() * user.reportIds.length)];
      const headers = getAuthHeaders(user.accessToken);
      
      const response = http.get(`${baseUrl}/api/v1/reports/${reportId}`, { headers });
      
      const success = check(response, {
        'report fetch status is 200': (r) => r.status === 200,
      });
      
      soakTestSuccessRate.add(success);
    }
  }
  
  // Sleep between 1-3 seconds to simulate realistic user behavior
  sleep(Math.random() * 2 + 1);
}

// Teardown
export function teardown(data) {
  console.log('Soak test completed');
}

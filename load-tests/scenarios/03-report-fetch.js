/**
 * Scenario 3: Report Fetch
 * 
 * Target: 1,000,000 total requests
 * Duration: Distributed over 10 minutes (10k RPS average)
 * Endpoint: GET /api/v1/reports/:id
 * 
 * Prerequisites: Authenticated users with existing reports
 * 
 * Assertions:
 * - Error rate < 0.1%
 * - Response time p95 < 300ms
 * - All fetches return 200 status
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { login, getAuthHeaders } from '../lib/auth.js';
import { getRandomReportId } from '../lib/data.js';
import { standardThresholds } from '../config/thresholds.js';
import config from '../config/environments.js';

// Custom metrics
const reportFetchSuccessRate = new Rate('report_fetch_success');

// Test options
export const options = {
  thresholds: {
    ...standardThresholds,
    'report_fetch_success': ['rate>0.999'],
  },
  
  scenarios: {
    report_fetch: {
      executor: 'shared-iterations',
      vus: 1000, // 1000 virtual users
      iterations: 1000000, // 1 million total iterations
      maxDuration: '10m', // Maximum 10 minutes
    },
  },
};

// Setup: Authenticate users and collect report IDs
export function setup() {
  const baseUrl = config.baseUrl;
  const testUsers = [];
  const userReports = []; // Array of {email, accessToken, reportIds}
  
  // Use existing test users
  const baseUsers = [
    { email: 'tushar@thukk.com', password: '111111' }, // Employee
    { email: 'admin@thukk.com', password: '111111' }, // Company Admin
    { email: 'example@sa.com', password: 'password123' }, // Super Admin
  ];
  
  // Cycle through base users
  for (let i = 0; i < 1000; i++) {
    testUsers.push(baseUsers[i % baseUsers.length]);
  }
  
  console.log(`Using ${baseUsers.length} base users for report fetch test`);
  
  // Authenticate each user and fetch their reports
  console.log(`Authenticating ${testUsers.length} users and fetching reports...`);
  let authenticatedCount = 0;
  
  for (const user of testUsers) {
    const authResult = login(baseUrl, user.email, user.password);
    if (authResult && authResult.accessToken) {
      const headers = getAuthHeaders(authResult.accessToken);
      
      // Fetch user's reports
      const response = http.get(`${baseUrl}/api/v1/reports`, {
        headers: headers,
        params: { page: 1, pageSize: 100 },
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
          console.log(`Failed to parse reports for ${user.email}`);
        }
      }
    }
    
    // Rate limit setup requests
    if (authenticatedCount % 100 === 0) {
      sleep(0.1);
    }
  }
  
  console.log(`Setup complete: ${authenticatedCount} users with ${userReports.reduce((sum, u) => sum + u.reportIds.length, 0)} total reports`);
  
  return {
    baseUrl,
    userReports,
  };
}

// Main test function
export default function (data) {
  const baseUrl = data.baseUrl;
  const userReports = data.userReports;
  
  if (userReports.length === 0) {
    console.error('No users with reports available');
    return;
  }
  
  // Select a random user
  const randomUserIndex = Math.floor(Math.random() * userReports.length);
  const user = userReports[randomUserIndex];
  
  if (user.reportIds.length === 0) {
    return;
  }
  
  // Select a random report ID
  const randomReportIndex = Math.floor(Math.random() * user.reportIds.length);
  const reportId = user.reportIds[randomReportIndex];
  
  const headers = getAuthHeaders(user.accessToken);
  
  // Fetch report
  const response = http.get(`${baseUrl}/api/v1/reports/${reportId}`, { headers });
  
  // Check response
  const success = check(response, {
    'report fetch status is 200': (r) => r.status === 200,
    'report fetch response has data': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true && body.data !== undefined;
      } catch (e) {
        return false;
      }
    },
  });
  
  reportFetchSuccessRate.add(success);
  
  // Small sleep
  sleep(0.01);
}

// Teardown
export function teardown(data) {
  console.log('Report fetch test completed');
}

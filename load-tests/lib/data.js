/**
 * Test data generation utilities for k6 load tests
 */

import http from 'k6/http';

/**
 * Generate random expense data
 * @param {Object} options - Options for expense generation
 * @param {string} options.categoryId - Optional category ID
 * @param {string} options.costCentreId - Optional cost centre ID
 * @param {string} options.projectId - Optional project ID
 * @param {number} options.minAmount - Minimum amount (default: 10)
 * @param {number} options.maxAmount - Maximum amount (default: 10000)
 * @returns {Object} - Expense data object
 */
export function generateExpenseData(options = {}) {
  const {
    categoryId,
    costCentreId,
    projectId,
    minAmount = 10,
    maxAmount = 10000,
  } = options;

  const vendors = [
    'Amazon', 'Uber', 'Starbucks', 'McDonald\'s', 'Shell', 'BP',
    'Hilton', 'Marriott', 'Airbnb', 'Booking.com', 'Expedia',
    'Office Depot', 'FedEx', 'DHL', 'Taxi', 'Restaurant XYZ',
    'Hotel ABC', 'Flight Booking', 'Train Ticket', 'Parking',
  ];

  const currencies = ['INR', 'USD', 'EUR', 'GBP'];
  const sources = ['MANUAL', 'SCANNED'];

  const amount = Math.floor(Math.random() * (maxAmount - minAmount + 1)) + minAmount;
  const expenseDate = new Date(Date.now() - Math.random() * 90 * 24 * 60 * 60 * 1000); // Random date within last 90 days

  return {
    vendor: vendors[Math.floor(Math.random() * vendors.length)],
    amount: amount,
    currency: currencies[Math.floor(Math.random() * currencies.length)],
    expenseDate: expenseDate.toISOString(),
    source: sources[Math.floor(Math.random() * sources.length)],
    notes: `Test expense - ${new Date().toISOString()}`,
    ...(categoryId && { categoryId }),
    ...(costCentreId && { costCentreId }),
    ...(projectId && { projectId }),
  };
}

/**
 * Generate test user credentials
 * @param {number} count - Number of users to generate
 * @param {string} prefix - Prefix for email addresses (default: 'loadtest')
 * @returns {Array} - Array of user objects with email and password
 */
export function generateTestUsers(count, prefix = 'loadtest') {
  const users = [];
  for (let i = 0; i < count; i++) {
    users.push({
      email: `${prefix}${i}@test.nexpense.com`,
      password: `TestPassword${i}!`,
      name: `Load Test User ${i}`,
    });
  }
  return users;
}

/**
 * Get random report ID for a user
 * @param {string} baseUrl - Base URL of the API
 * @param {Object} headers - Authentication headers
 * @returns {string|null} - Report ID or null if not found
 */
export function getRandomReportId(baseUrl, headers) {
  const response = http.get(`${baseUrl}/api/v1/reports`, {
    headers: headers,
    params: {
      page: 1,
      pageSize: 100,
    },
  });

  if (response.status === 200) {
    const body = JSON.parse(response.body);
    if (body.success && body.data && body.data.length > 0) {
      const randomIndex = Math.floor(Math.random() * body.data.length);
      return body.data[randomIndex]._id || body.data[randomIndex].id;
    }
  }

  return null;
}

/**
 * Create a test report for a user
 * @param {string} baseUrl - Base URL of the API
 * @param {Object} headers - Authentication headers
 * @param {string} name - Report name (optional)
 * @returns {string|null} - Report ID or null if creation failed
 */
export function createTestReport(baseUrl, headers, name = null) {
  const reportName = name || `Load Test Report ${Date.now()}`;
  const response = http.post(`${baseUrl}/api/v1/reports`, JSON.stringify({
    name: reportName,
    description: 'Test report for load testing',
  }), {
    headers: headers,
  });

  if (response.status === 201) {
    const body = JSON.parse(response.body);
    if (body.success && body.data) {
      return body.data._id || body.data.id;
    }
  }

  return null;
}

/**
 * Get random category ID (cached from API)
 * @param {string} baseUrl - Base URL of the API
 * @param {Object} headers - Authentication headers
 * @param {Array} cachedCategories - Cached category array (will be populated if empty)
 * @returns {string|null} - Category ID or null
 */
export function getRandomCategoryId(baseUrl, headers, cachedCategories = []) {
  if (cachedCategories.length === 0) {
    // Fetch categories from API (assuming there's a categories endpoint)
    // If not available, return null
    return null;
  }

  const randomIndex = Math.floor(Math.random() * cachedCategories.length);
  return cachedCategories[randomIndex]._id || cachedCategories[randomIndex].id;
}

/**
 * Generate random string
 * @param {number} length - Length of string
 * @returns {string} - Random string
 */
export function randomString(length = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Shared threshold definitions for k6 load tests
 */

/**
 * Get standard thresholds for all scenarios
 * @returns {Object} - Thresholds object
 */
export function getStandardThresholds() {
  return {
    // Error rate must be less than 0.1%
    'http_req_failed': ['rate<0.001'],
    
    // 95% of requests must complete within 300ms
    'http_req_duration': ['p(95)<300'],
    
    // 99% of requests must complete within 500ms
    'http_req_duration': ['p(99)<500'],
    
    // Successful requests (200) should be fast
    'http_req_duration{status:200}': ['p(95)<300'],
    
    // Created requests (201) should be fast
    'http_req_duration{status:201}': ['p(95)<300'],
    
    // Failed auth (401) should fail fast
    'http_req_duration{status:401}': ['p(95)<200'],
    
    // Server errors (5xx) should be minimal
    'http_req_duration{status:500}': ['p(95)<1000'],
  };
}

/**
 * Get relaxed thresholds for spike tests
 * @returns {Object} - Relaxed thresholds object
 */
export function getRelaxedThresholds() {
  return {
    // Error rate must be less than 0.1% even during spike
    'http_req_failed': ['rate<0.001'],
    
    // 95% of requests must complete within 500ms (relaxed for spike)
    'http_req_duration': ['p(95)<500'],
    
    // 99% of requests must complete within 1000ms
    'http_req_duration': ['p(99)<1000'],
    
    // Successful requests (200) should be reasonable
    'http_req_duration{status:200}': ['p(95)<500'],
    
    // Created requests (201) should be reasonable
    'http_req_duration{status:201}': ['p(95)<500'],
  };
}

/**
 * Get custom metric thresholds
 * @param {Array} metrics - Optional array of metric names to include
 * @returns {Object} - Custom metric thresholds
 */
export function getCustomThresholds(metrics = []) {
  const allMetrics = {
    // Authentication success rate
    'auth_success': ['rate>0.999'],
    
    // Expense creation success rate
    'expense_creation_success': ['rate>0.999'],
    
    // Report fetch success rate
    'report_fetch_success': ['rate>0.999'],
    
    // Mixed workload success rate
    'mixed_workload_success': ['rate>0.999'],
    
    // Soak test success rate
    'soak_test_success': ['rate>0.999'],
  };
  
  // If specific metrics requested, filter
  if (metrics.length > 0) {
    const filtered = {};
    metrics.forEach(metric => {
      if (allMetrics[metric]) {
        filtered[metric] = allMetrics[metric];
      }
    });
    return filtered;
  }
  
  // Return all (k6 will ignore metrics that don't exist)
  return allMetrics;
}

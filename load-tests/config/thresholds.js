/**
 * Threshold configurations for k6 load tests
 */

import { getStandardThresholds, getRelaxedThresholds, getCustomThresholds } from '../lib/thresholds.js';

/**
 * Standard thresholds for most scenarios
 * - Error rate < 0.1%
 * - Response time p95 < 300ms
 * - Response time p99 < 500ms
 */
export const standardThresholds = getStandardThresholds();

/**
 * Relaxed thresholds for spike tests
 * - Error rate < 0.1%
 * - Response time p95 < 500ms (relaxed)
 * - Response time p99 < 1000ms
 */
export const relaxedThresholds = getRelaxedThresholds();

/**
 * Custom metric thresholds
 */
export const customThresholds = getCustomThresholds();

/**
 * Combined thresholds (standard + custom)
 * Note: k6 will ignore custom metrics that don't exist in the test
 */
export const combinedThresholds = {
  ...standardThresholds,
  ...customThresholds,
};

/**
 * Combined relaxed thresholds (for spike tests)
 * Note: k6 will ignore custom metrics that don't exist in the test
 */
export const combinedRelaxedThresholds = {
  ...relaxedThresholds,
  ...customThresholds,
};

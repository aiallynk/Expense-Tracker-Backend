/**
 * Analytics snapshot worker: processes queued analytics events and updates
 * company_analytics_snapshot. Runs in-process; no Redis/Bull required.
 */
import { analyticsQueue } from '../utils/analyticsQueue';
import { processAnalyticsJob } from '../services/companyAnalyticsSnapshot.service';
import { logger } from '../config/logger';

let started = false;

export function startAnalyticsSnapshotWorker(): void {
  if (started) {
    logger.warn('Analytics snapshot worker already started');
    return;
  }
  analyticsQueue.setProcessor(processAnalyticsJob);
  started = true;
  logger.info('Analytics snapshot worker started');
}

export function stopAnalyticsSnapshotWorker(): void {
  if (!started) return;
  analyticsQueue.shutdown();
  started = false;
  logger.info('Analytics snapshot worker stopped');
}

export function isAnalyticsSnapshotWorkerRunning(): boolean {
  return started;
}

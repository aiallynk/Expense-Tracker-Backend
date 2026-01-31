/**
 * In-process queue for company analytics snapshot updates.
 * Jobs are processed by a single worker to avoid race conditions on snapshot documents.
 */
import PQueue from 'p-queue';
import { logger } from '../config/logger';

export type AnalyticsEventType =
  | 'REPORT_SUBMITTED'
  | 'REPORT_APPROVED'
  | 'REPORT_REJECTED'
  | 'EXPENSE_ADDED'
  | 'VOUCHER_APPLIED'
  | 'SETTLEMENT_COMPLETED'
  | 'REBUILD_SNAPSHOT';

export interface AnalyticsJobPayload {
  companyId: string;
  event: AnalyticsEventType;
  reportId?: string;
  userId?: string;
  [key: string]: unknown;
}

export interface AnalyticsQueueJob {
  id: string;
  payload: AnalyticsJobPayload;
  createdAt: Date;
}

let jobIdCounter = 0;
function nextJobId(): string {
  jobIdCounter += 1;
  return `analytics-${Date.now()}-${jobIdCounter}`;
}

class AnalyticsQueueClass {
  private queue: PQueue;
  private processor: ((job: AnalyticsQueueJob) => Promise<void>) | null = null;
  private isShuttingDown = false;

  constructor() {
    this.queue = new PQueue({ concurrency: 1 });
  }

  /**
   * Set the processor that will handle each job. Called by the worker on startup.
   */
  setProcessor(processor: (job: AnalyticsQueueJob) => Promise<void>): void {
    this.processor = processor;
  }

  /**
   * Enqueue an analytics update job. Non-blocking; returns immediately.
   */
  enqueue(payload: AnalyticsJobPayload): void {
    if (this.isShuttingDown) {
      logger.warn({ payload }, 'Analytics queue is shutting down, dropping job');
      return;
    }
    const job: AnalyticsQueueJob = {
      id: nextJobId(),
      payload,
      createdAt: new Date(),
    };
    this.queue
      .add(async () => {
        if (!this.processor) {
          logger.warn({ jobId: job.id }, 'Analytics queue has no processor, skipping job');
          return;
        }
        try {
          await this.processor(job);
        } catch (error) {
          logger.error({ error, jobId: job.id, payload: job.payload }, 'Analytics job failed');
        }
      })
      .catch((err) => {
        logger.error({ err, jobId: job.id }, 'Analytics queue add failed');
      });
  }

  size(): number {
    return this.queue.size + this.queue.pending;
  }

  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  shutdown(): void {
    this.isShuttingDown = true;
    this.queue.clear();
  }
}

export const analyticsQueue = new AnalyticsQueueClass();

// @ts-ignore - Module may not be installed
import PQueue from 'p-queue';

import { config } from '../config/index';
import { logger } from '../config/logger';
import { OcrDispatcherService } from '../services/ocrDispatcher.service';

export type QueueJobStatus = 'IDLE' | 'QUEUED' | 'PROCESSING' | 'SUCCESS' | 'FAILED';

export interface QueueJob {
  jobId: string;
  receiptId: string;
  userId?: string; // User ID for per-user concurrency limits
  createdAt: Date;
  startTime?: Date; // When processing started (for timeout tracking)
  attempts?: number; // Number of processing attempts
  /** Batch upload: use BLAST limits when batchSize > 1 */
  batchId?: string;
  batchSize?: number;
  /** Job state for logging (IDLE → QUEUED → PROCESSING → SUCCESS | FAILED) */
  status?: QueueJobStatus;
}

export interface QueueAddResult {
  queued: boolean;
  position?: number; // Queue position if queued
}

/**
 * OCR Queue using p-queue for parallel processing
 * Supports global and per-user throttling via environment variables
 */
class OcrQueue {
  private queue: PQueue;
  private maxSize: number = 100; // Safe queue size limit
  private isShuttingDown: boolean = false;
  private jobProcessors: Map<string, (job: QueueJob) => Promise<void>> = new Map();
  
  // Throttling counters (in-memory)
  private globalActiveOcr: number = 0; // Global active OCR count
  private perUserActiveOcr: Map<string, number> = new Map(); // Per-user active OCR count
  
  // FIFO queue for throttled requests
  private throttledQueue: Array<{
    job: QueueJob;
    processor: (job: QueueJob) => Promise<void>;
  }> = [];
  
  // Track queued jobs for position calculation (userId -> jobIds[])
  private userQueues: Map<string, string[]> = new Map();
  // Track all jobs for position calculation (jobId -> userId)
  private jobUserMap: Map<string, string> = new Map();
  // Store full job data for queued jobs (jobId -> QueueJob)
  private queuedJobs: Map<string, QueueJob> = new Map();
  // Queue stats logging interval
  private statsLogInterval?: NodeJS.Timeout;
  // Track cleaned jobs to avoid double cleanup (e.g. timeout + throw)
  private cleanedJobIds: Set<string> = new Set();

  constructor() {
    // Queue task timeout: at least 30s so OCR (often 5–10s per receipt) doesn't get killed by p-queue
    const queueTaskTimeoutMs = Math.max(config.ocr.timeoutMs, 30000);
    // Use high concurrency for p-queue (it will be throttled by our counters)
    this.queue = new PQueue({
      concurrency: config.ocr.maxGlobalOcr * 2, // Allow p-queue to handle more, we throttle manually
      timeout: queueTaskTimeoutMs,
    });
    
    // Start periodic queue stats logging (every 30s)
    this.startStatsLogging();
  }

  /**
   * Add a job to the queue with its processor function
   * Implements throttling: checks global and per-user limits before starting OCR
   * @param job - Job data (must include userId for per-user limits)
   * @param processor - Function to process the job
   * @returns QueueAddResult with queued status and position
   * @throws Error if queue is full or shutting down
   */
  async add(
    job: QueueJob,
    processor: (job: QueueJob) => Promise<void>
  ): Promise<QueueAddResult> {
    if (this.isShuttingDown) {
      throw new Error('Queue is shutting down, cannot enqueue new jobs');
    }

    // Check queue size (throttled queue + p-queue pending + p-queue size)
    const currentSize = this.throttledQueue.length + this.queue.size + this.queue.pending;
    if (currentSize >= this.maxSize) {
      throw new Error(`Queue is full (max size: ${this.maxSize}). Please try again later.`);
    }

    // Check throttling limits BEFORE starting OCR (batch jobs use BLAST limits)
    const shouldThrottle = this.shouldThrottle(job.userId, { batchId: job.batchId, batchSize: job.batchSize });
    
    if (shouldThrottle.throttle) {
      // Throttled - add to FIFO queue
      const position = this.throttledQueue.length + 1;
      job.status = 'QUEUED';
      this.throttledQueue.push({ job, processor });
      logger.debug({ jobId: job.jobId, receiptId: job.receiptId, position }, '[OCR] job_queued');

      // Track for position calculation
      if (job.userId) {
        const userQueue = this.userQueues.get(job.userId) || [];
        userQueue.push(job.jobId);
        this.userQueues.set(job.userId, userQueue);
        this.jobUserMap.set(job.jobId, job.userId);
        this.queuedJobs.set(job.jobId, job);
      }

      return { queued: true, position };
    }

    logger.debug({ jobId: job.jobId, receiptId: job.receiptId }, '[OCR] job_added');

    // Not throttled - start immediately
    return this.startOcrJob(job, processor);
  }

  /**
   * Active user count: distinct users with in-flight or queued OCR jobs.
   */
  getActiveUserCount(): number {
    const userSet = new Set<string>();
    this.perUserActiveOcr.forEach((_count, uid) => userSet.add(uid));
    this.throttledQueue.forEach(({ job }) => {
      if (job.userId) userSet.add(job.userId);
    });
    return userSet.size;
  }

  /**
   * Active OCR job count: in progress + waiting in throttled queue + waiting in p-queue.
   */
  getActiveOcrJobCount(): number {
    return this.globalActiveOcr + this.throttledQueue.length + this.queue.size;
  }

  /**
   * Get current limits from traffic-aware dispatcher (BLAST vs CONTROLLED).
   * When job has batchSize > 1, force BLAST so batch jobs run in parallel.
   * For batch jobs, per-user limit is at least batchSize so all receipts in the batch can start.
   */
  private getCurrentLimits(job?: { batchId?: string; batchSize?: number }): { maxGlobalOcr: number; maxPerUserOcr: number } {
    const activeUserCount = this.getActiveUserCount();
    const activeOcrJobCount = this.getActiveOcrJobCount();
    const mode = (job?.batchSize && job.batchSize > 1)
      ? 'BLAST'
      : OcrDispatcherService.getMode(activeUserCount, activeOcrJobCount);
    const limits = OcrDispatcherService.getLimits(mode);
    // For batch uploads: allow at least batchSize concurrent so ALL receipts in batch run (fixes "not extracting after 6")
    if (job?.batchSize && job.batchSize > 1) {
      const effectivePerUser = Math.max(limits.maxPerUserOcr, job.batchSize);
      const effectiveGlobal = Math.max(limits.maxGlobalOcr, job.batchSize);
      return { maxGlobalOcr: effectiveGlobal, maxPerUserOcr: effectivePerUser };
    }
    return limits;
  }

  /**
   * Check if job should be throttled based on global and per-user limits (traffic-aware).
   * Batch jobs (batchSize > 1) use BLAST limits.
   */
  private shouldThrottle(userId?: string, job?: { batchId?: string; batchSize?: number }): { throttle: boolean; reason?: string } {
    const limits = this.getCurrentLimits(job);

    if (this.globalActiveOcr >= limits.maxGlobalOcr) {
      return { throttle: true, reason: 'global_limit' };
    }

    if (userId) {
      const userActiveCount = this.perUserActiveOcr.get(userId) || 0;
      if (userActiveCount >= limits.maxPerUserOcr) {
        return { throttle: true, reason: 'per_user_limit' };
      }
    }

    return { throttle: false };
  }

  /**
   * Decrement counters and clean up after a job finishes (success, failure, or timeout).
   * Idempotent: safe to call multiple times for the same job.
   * Always calls processNextThrottledJob so queue keeps draining (one job fail does not block queue).
   */
  private decrementAndCleanup(job: QueueJob): void {
    if (this.cleanedJobIds.has(job.jobId)) return;
    this.cleanedJobIds.add(job.jobId);

    this.globalActiveOcr = Math.max(0, this.globalActiveOcr - 1);
    if (job.userId) {
      const userCount = this.perUserActiveOcr.get(job.userId) || 0;
      this.perUserActiveOcr.set(job.userId, Math.max(0, userCount - 1));
      if (this.perUserActiveOcr.get(job.userId) === 0) {
        this.perUserActiveOcr.delete(job.userId);
      }
      this.jobUserMap.delete(job.jobId);
    }
    this.jobProcessors.delete(job.jobId);
    this.processNextThrottledJob();
  }

  /**
   * Start OCR job immediately (increments counters and executes)
   */
  private startOcrJob(
    job: QueueJob,
    processor: (job: QueueJob) => Promise<void>
  ): QueueAddResult {
    // Increment counters BEFORE starting
    this.globalActiveOcr++;
    if (job.userId) {
      const userCount = this.perUserActiveOcr.get(job.userId) || 0;
      this.perUserActiveOcr.set(job.userId, userCount + 1);
      this.jobUserMap.set(job.jobId, job.userId);
    }

    job.status = 'PROCESSING';
    job.startTime = new Date();
    logger.debug({ jobId: job.jobId, receiptId: job.receiptId }, '[OCR] job_started');

    // Store processor
    this.jobProcessors.set(job.jobId, processor);

    const maxRetries = (config.ocr as { maxRetries?: number }).maxRetries ?? 1;

    // Add to p-queue (non-blocking). Catch timeout/rejection so we don't get unhandled promise rejection.
    this.queue
      .add(async () => {
        let lastError: Error | undefined;
        try {
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              await processor(job);
              job.status = 'SUCCESS';
              logger.debug({ jobId: job.jobId, receiptId: job.receiptId, attempt }, '[OCR] job_completed');
              return;
            } catch (err) {
              lastError = err as Error;
              job.attempts = (job.attempts || 0) + 1;
              if (attempt < maxRetries) {
                logger.warn({ jobId: job.jobId, receiptId: job.receiptId, attempt, maxRetries }, '[OCR] job_retry');
              } else {
                job.status = 'FAILED';
                logger.error({ jobId: job.jobId, receiptId: job.receiptId, attempt }, '[OCR] job_failed');
                throw lastError;
              }
            }
          }
        } finally {
          this.decrementAndCleanup(job);
        }
      })
      .catch((err: Error) => {
        this.decrementAndCleanup(job); // In case task was aborted (e.g. timeout) before finally ran
        const isTimeout = err?.name === 'TimeoutError' || err?.message?.includes('timed out');
        logger.error(
          { err, jobId: job.jobId, receiptId: job.receiptId, isTimeout },
          isTimeout ? 'OCR queue task timed out (job may still complete in background)' : 'OCR queue task failed'
        );
      });

    return { queued: false };
  }

  /**
   * Process next throttled job from FIFO queue (called when any OCR finishes)
   */
  private processNextThrottledJob(): void {
    if (this.throttledQueue.length === 0) {
      return; // No queued jobs
    }

    // Try to start jobs from FIFO queue until limits are reached
    while (this.throttledQueue.length > 0) {
      const next = this.throttledQueue[0];
      const shouldThrottle = this.shouldThrottle(next.job.userId, { batchId: next.job.batchId, batchSize: next.job.batchSize });
      
      if (shouldThrottle.throttle) {
        // Still throttled - stop processing
        break;
      }

      // Can start - remove from queue and start
      this.throttledQueue.shift();
      
      // Remove from user queue tracking
      if (next.job.userId) {
        const userQueue = this.userQueues.get(next.job.userId) || [];
        const index = userQueue.indexOf(next.job.jobId);
        if (index !== -1) {
          userQueue.splice(index, 1);
          this.userQueues.set(next.job.userId, userQueue);
        }
        this.queuedJobs.delete(next.job.jobId);
      }

      // Start the job
      this.startOcrJob(next.job, next.processor);
    }
  }

  /**
   * Legacy enqueue method (for backward compatibility)
   * @deprecated Use add() instead
   */
  enqueue(_job: QueueJob): void {
    // This is a no-op - jobs should be added via add() with processor
    logger.warn('enqueue() called without processor - use add(job, processor) instead');
  }

  /**
   * Legacy dequeue method (not used with p-queue)
   * @deprecated p-queue handles dequeuing automatically
   */
  dequeue(): QueueJob | null {
    // p-queue handles this automatically
    return null;
  }

  /**
   * Get current queue size (waiting + pending)
   */
  size(): number {
    return this.queue.size + this.queue.pending;
  }

  /**
   * Get pending jobs count (currently processing)
   */
  pending(): number {
    return this.queue.pending;
  }

  /**
   * Check if queue is full
   */
  isFull(): boolean {
    return this.size() >= this.maxSize;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.size === 0 && this.queue.pending === 0;
  }

  /**
   * Get max queue size
   */
  getMaxSize(): number {
    return this.maxSize;
  }

  /**
   * Check if queue is shutting down
   */
  isShutdown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Legacy method - p-queue handles concurrency automatically
   * @deprecated Not needed with p-queue
   */
  setProcessing(_value: boolean): void {
    // p-queue handles this automatically
  }

  /**
   * Check if queue is currently processing
   */
  isProcessing(): boolean {
    return this.queue.pending > 0;
  }

  /**
   * Wait for all jobs to complete
   */
  async onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  /**
   * Pause queue (stops processing new jobs)
   */
  pause(): void {
    this.queue.pause();
  }

  /**
   * Resume queue (starts processing jobs)
   */
  start(): void {
    this.queue.start();
  }

  /**
   * Gracefully shutdown queue
   * Prevents new jobs from being enqueued
   * Returns remaining jobs count
   */
  shutdown(): number {
    this.isShuttingDown = true;
    this.stopStatsLogging();
    const remaining = this.size();
    
    if (remaining > 0) {
      logger.warn({ remainingJobs: remaining }, 'Queue shutdown with remaining jobs');
    }
    
    return remaining;
  }

  /**
   * Clear all jobs from queue (use with caution)
   */
  clear(): void {
    this.queue.clear();
    this.throttledQueue = [];
    this.jobProcessors.clear();
    this.userQueues.clear();
    this.jobUserMap.clear();
    this.queuedJobs.clear();
    this.cleanedJobIds.clear();
    this.perUserActiveOcr.clear();
    this.globalActiveOcr = 0;
  }

  /**
   * Get all jobs in queue (for monitoring)
   * Note: p-queue doesn't expose job data, so this returns empty array
   */
  getAllJobs(): QueueJob[] {
    // p-queue doesn't expose job data
    return [];
  }

  /**
   * Get queue position for a user
   * @param userId - User ID
   * @returns Queue position (0 = no queue, 1+ = position in queue)
   */
  getUserQueuePosition(userId: string): number {
    // Count jobs in throttled queue for this user
    let position = 0;
    for (const queued of this.throttledQueue) {
      if (queued.job.userId === userId) {
        position++;
      }
    }
    return position;
  }

  /**
   * Start periodic queue stats logging (every 30s)
   */
  private startStatsLogging(): void {
    if (this.statsLogInterval) {
      clearInterval(this.statsLogInterval);
    }
    
    this.statsLogInterval = setInterval(() => {
      const size = this.queue.size;
      const pending = this.queue.pending;
      const throttled = this.throttledQueue.length;
      const perUser: Record<string, number> = {};
      
      // Build per-user stats
      this.perUserActiveOcr.forEach((count, userId) => {
        if (count > 0) {
          perUser[userId] = count;
        }
      });
      
      const mode = OcrDispatcherService.getMode(
        this.getActiveUserCount(),
        this.getActiveOcrJobCount()
      );
      const limits = OcrDispatcherService.getLimits(mode);
      logger.info({
        size,
        pending,
        throttled,
        globalActive: this.globalActiveOcr,
        perUser: Object.keys(perUser).length > 0 ? perUser : undefined,
        mode,
        limitsMaxGlobal: limits.maxGlobalOcr,
        limitsMaxPerUser: limits.maxPerUserOcr,
      }, '[OCR] queue_stats');
    }, 30000); // Every 30 seconds
  }


  /**
   * Stop stats logging
   */
  stopStatsLogging(): void {
    if (this.statsLogInterval) {
      clearInterval(this.statsLogInterval);
      this.statsLogInterval = undefined;
    }
  }
}

// Singleton instance
export const ocrQueue = new OcrQueue();

import PQueue from 'p-queue';

import { config } from '../config/index';
import { logger } from '../config/logger';

export interface QueueJob {
  jobId: string;
  receiptId: string;
  userId?: string; // User ID for per-user concurrency limits
  createdAt: Date;
  startTime?: Date; // When processing started (for timeout tracking)
  attempts?: number; // Number of processing attempts
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

  constructor() {
    // Use high concurrency for p-queue (it will be throttled by our counters)
    this.queue = new PQueue({
      concurrency: config.ocr.maxGlobalOcr * 2, // Allow p-queue to handle more, we throttle manually
      timeout: config.ocr.timeoutMs, // Use OCR_TIMEOUT_MS
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

    // Check throttling limits BEFORE starting OCR
    const shouldThrottle = this.shouldThrottle(job.userId);
    
    if (shouldThrottle.throttle) {
      // Throttled - add to FIFO queue
      const position = this.throttledQueue.length + 1;
      this.throttledQueue.push({ job, processor });
      
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

    // Not throttled - start immediately
    return this.startOcrJob(job, processor);
  }

  /**
   * Check if job should be throttled based on global and per-user limits
   */
  private shouldThrottle(userId?: string): { throttle: boolean; reason?: string } {
    // Check global limit
    if (this.globalActiveOcr >= config.ocr.maxGlobalOcr) {
      return { throttle: true, reason: 'global_limit' };
    }

    // Check per-user limit
    if (userId) {
      const userActiveCount = this.perUserActiveOcr.get(userId) || 0;
      if (userActiveCount >= config.ocr.maxPerUserOcr) {
        return { throttle: true, reason: 'per_user_limit' };
      }
    }

    return { throttle: false };
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

    // Store processor
    this.jobProcessors.set(job.jobId, processor);

    // Add to p-queue (non-blocking, processes automatically)
    this.queue.add(
      async () => {
        try {
          job.startTime = new Date();
          await processor(job);
        } finally {
          // ALWAYS decrement counters in finally block (prevents memory leaks)
          this.globalActiveOcr = Math.max(0, this.globalActiveOcr - 1);
          
          if (job.userId) {
            const userCount = this.perUserActiveOcr.get(job.userId) || 0;
            this.perUserActiveOcr.set(job.userId, Math.max(0, userCount - 1));
            
            // Clean up empty user entries to prevent memory leaks
            if (this.perUserActiveOcr.get(job.userId) === 0) {
              this.perUserActiveOcr.delete(job.userId);
            }
            
            this.jobUserMap.delete(job.jobId);
          }
          
          // Clean up processor reference
          this.jobProcessors.delete(job.jobId);
          
          // Auto-start next throttled job (FIFO)
          this.processNextThrottledJob();
        }
      }
    );

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
      const shouldThrottle = this.shouldThrottle(next.job.userId);
      
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
      
      logger.info({
        size,
        pending,
        throttled,
        globalActive: this.globalActiveOcr,
        perUser: Object.keys(perUser).length > 0 ? perUser : undefined,
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

import { logger } from '../config/logger';

export interface QueueJob {
  jobId: string;
  receiptId: string;
  createdAt: Date;
}

class InProcessQueue {
  private queue: QueueJob[] = [];
  private maxSize: number = 500;
  private isShuttingDown: boolean = false;
  private processing: boolean = false;

  /**
   * Enqueue a new OCR job
   * @throws Error if queue is full or shutting down
   */
  enqueue(job: QueueJob): void {
    if (this.isShuttingDown) {
      throw new Error('Queue is shutting down, cannot enqueue new jobs');
    }

    if (this.queue.length >= this.maxSize) {
      throw new Error(`Queue is full (max size: ${this.maxSize}). Please try again later.`);
    }

    this.queue.push(job);
  }

  /**
   * Dequeue the next job (FIFO)
   * @returns Next job or null if queue is empty
   */
  dequeue(): QueueJob | null {
    if (this.queue.length === 0) {
      return null;
    }
    return this.queue.shift() || null;
  }

  /**
   * Get current queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is full
   */
  isFull(): boolean {
    return this.queue.length >= this.maxSize;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
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
   * Mark queue as processing (to prevent concurrent processing)
   */
  setProcessing(value: boolean): void {
    this.processing = value;
  }

  /**
   * Check if queue is currently processing
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Gracefully shutdown queue
   * Prevents new jobs from being enqueued
   * Returns remaining jobs count
   */
  shutdown(): number {
    this.isShuttingDown = true;
    const remaining = this.queue.length;
    
    if (remaining > 0) {
      logger.warn({ remainingJobs: remaining }, 'Queue shutdown with remaining jobs');
    }
    
    return remaining;
  }

  /**
   * Clear all jobs from queue (use with caution)
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Get all jobs in queue (for monitoring)
   */
  getAllJobs(): QueueJob[] {
    return [...this.queue];
  }
}

// Singleton instance
export const ocrQueue = new InProcessQueue();

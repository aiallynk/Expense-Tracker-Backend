import { config } from '../config/index';
import { ocrQueue } from '../utils/inProcessQueue';
import { OcrService } from '../services/ocr.service';
import { logger } from '../config/logger';

let isRunning = false;
let workerInterval: NodeJS.Timeout | null = null;
let shutdownRequested = false;

/**
 * Process a single OCR job from the queue
 */
const processNextJob = async (): Promise<void> => {
  // Prevent concurrent processing
  if (ocrQueue.isProcessing()) {
    return;
  }

  // Check if queue is empty or shutting down
  if (ocrQueue.isEmpty() || ocrQueue.isShutdown() || shutdownRequested) {
    return;
  }

  // Get next job from queue
  const job = ocrQueue.dequeue();
  if (!job) {
    return;
  }

  // Mark as processing
  ocrQueue.setProcessing(true);

  try {
    logger.info({ jobId: job.jobId, receiptId: job.receiptId }, 'OCR job started');
    
    // Process the OCR job
    await OcrService.processOcrJob(job.jobId);
    
    logger.info({ jobId: job.jobId, receiptId: job.receiptId }, 'OCR job completed');
  } catch (error: any) {
    logger.error({
      jobId: job.jobId,
      receiptId: job.receiptId,
      error: error.message,
    }, 'OCR job failed');
    // Don't throw - continue processing other jobs
  } finally {
    // Mark as not processing
    ocrQueue.setProcessing(false);
  }
};

/**
 * Start the in-process OCR worker
 */
export const startInProcessOcrWorker = (): void => {
  if (isRunning) {
    logger.warn('In-process OCR worker is already running');
    return;
  }

  if (config.ocr.disableOcr) {
    logger.info('OCR is disabled, skipping worker startup');
    return;
  }

  isRunning = true;
  shutdownRequested = false;

  // Get concurrency from config (1 in DEMO_MODE)
  const concurrency = config.ocr.demoConcurrency || 1;
  
  logger.info({
    concurrency,
    demoMode: config.app.demoMode,
    queueMaxSize: ocrQueue.getMaxSize(),
  }, 'In-process OCR worker started');

  // Process jobs with specified concurrency
  // In DEMO_MODE, concurrency = 1 (process one at a time)
  const processJobs = async () => {
    if (shutdownRequested || ocrQueue.isShutdown()) {
      return;
    }

    // Process up to concurrency jobs in parallel
    const promises: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      promises.push(processNextJob());
    }
    
    await Promise.allSettled(promises);
  };

  // Run worker loop every 500ms (check for new jobs)
  workerInterval = setInterval(() => {
    processJobs().catch((error) => {
      logger.error({ error: error.message }, 'Worker process error');
    });
  }, 500);

  // Also process immediately
  processJobs().catch((error) => {
    logger.error({ error: error.message }, 'Initial worker process error');
  });
};

/**
 * Stop the in-process OCR worker gracefully
 */
export const stopInProcessOcrWorker = async (): Promise<void> => {
  if (!isRunning) {
    return;
  }

  logger.info('Stopping in-process OCR worker');
  shutdownRequested = true;

  // Clear interval
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }

  // Wait for current processing to complete (max 30 seconds)
  const maxWait = 30000; // 30 seconds
  const startTime = Date.now();

  while (ocrQueue.isProcessing() && (Date.now() - startTime) < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Shutdown queue
  const remaining = ocrQueue.shutdown();
  
  if (remaining > 0) {
    logger.warn({ remainingJobs: remaining }, 'Worker stopped with remaining jobs in queue');
  }

  isRunning = false;
  logger.info('In-process OCR worker stopped');
};

/**
 * Check if worker is running
 */
export const isWorkerRunning = (): boolean => {
  return isRunning;
};

import { config } from '../config/index';
import { ocrQueue } from '../utils/inProcessQueue';
import { logger } from '../config/logger';

let isRunning = false;

/**
 * Start the in-process OCR worker
 * With p-queue, processing happens automatically when jobs are added
 * No polling loop needed - p-queue handles concurrency and processing
 */
export const startInProcessOcrWorker = (): void => {
  if (isRunning) {
    logger.warn('OCR worker already running');
    return;
  }

  if (config.ocr.disableOcr) {
    logger.info('OCR disabled, skipping worker startup');
    return;
  }

  isRunning = true;

  logger.info({
    concurrency: config.ocr.concurrency,
    timeout: config.ocr.timeout,
    queueMaxSize: ocrQueue.getMaxSize(),
  }, 'OCR worker started with p-queue');

  // p-queue handles processing automatically
  // Jobs are processed as they're added via OcrService.enqueueOcrJob()
  // No polling loop needed
};

/**
 * Stop the in-process OCR worker gracefully
 * Waits for all jobs to complete
 */
export const stopInProcessOcrWorker = async (): Promise<void> => {
  if (!isRunning) {
    return;
  }

  logger.info('Stopping OCR worker');

  // Wait for all jobs to complete (p-queue handles this)
  try {
    await ocrQueue.onIdle();
  } catch (error) {
    logger.warn({ error }, 'Error waiting for queue to be idle');
  }

  // Shutdown queue
  const remaining = ocrQueue.shutdown();

  if (remaining > 0) {
    logger.warn({ remainingJobs: remaining }, 'Worker stopped with remaining jobs in queue');
  }

  isRunning = false;
  logger.info('OCR worker stopped');
};

/**
 * Check if worker is running
 */
export const isWorkerRunning = (): boolean => {
  return isRunning;
};

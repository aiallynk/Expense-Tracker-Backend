import { Worker, Job } from 'bullmq';

import { connectDB, disconnectDB } from '../config/db';
import { config } from '../config/index';
import { redisConnection, isRedisAvailable, initializeRedisIfNeeded } from '../config/queue';
import { OcrJob } from '../models/OcrJob';
import { OcrService } from '../services/ocr.service';
import { OcrJobStatus } from '../utils/enums';

import { logger } from '@/config/logger';


interface OcrJobData {
  jobId: string;
  receiptId: string;
}

// Store worker reference for graceful shutdown
let worker: Worker<OcrJobData> | null = null;

/**
 * Graceful shutdown handler for worker
 */
const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'OCR worker graceful shutdown initiated');

  // Close worker
  if (worker) {
    try {
      await worker.close();
      logger.info('OCR worker closed');
    } catch (error) {
      logger.error({ error }, 'Error closing OCR worker');
    }
  }

  // Close MongoDB connection
  try {
    await disconnectDB();
    logger.info('MongoDB disconnected');
  } catch (error) {
    logger.error({ error }, 'Error disconnecting from MongoDB');
  }

  // Close Redis connection
  try {
    if (redisConnection) {
      await redisConnection.quit();
      logger.info('Redis connection closed');
    }
  } catch (error) {
    logger.error({ error }, 'Error closing Redis connection');
  }

  logger.info('OCR worker graceful shutdown complete');
  process.exit(0);
};

// Connect to MongoDB
connectDB()
  .then(() => {
    logger.info('MongoDB connected in worker');
  })
  .catch((err) => {
    logger.error({ error: err }, 'Failed to connect to MongoDB in worker');
    process.exit(1);
  });

// Initialize Redis connection (required for OCR worker)
initializeRedisIfNeeded()
  .then((redisConnected) => {
    if (!redisConnected) {
      logger.error(
        {
          redisHost: config.redis.host,
          redisPort: config.redis.port,
        },
        'Redis connection failed - OCR worker cannot start'
      );
      logger.info('OCR worker exiting. Please ensure Redis is running and configured.');
      process.exit(1);
    }

    // Wait a bit for Redis to be ready
    setTimeout(() => {
      if (!isRedisAvailable()) {
        logger.warn(
          {
            redisHost: config.redis.host,
            redisPort: config.redis.port,
          },
          'Redis is not ready - OCR worker may not function correctly'
        );
        // In development, allow worker to start but warn
        if (config.app.env === 'production') {
          logger.error('Redis is required in production - exiting worker');
          process.exit(1);
        }
      }
      // Start the worker after Redis is ready
      startWorker();
    }, 2000);
  })
  .catch((err) => {
    logger.error({ error: err }, 'Failed to initialize Redis connection');
    process.exit(1);
  });

// Start the worker (called after Redis is initialized)
const startWorker = () => {
  if (!redisConnection) {
    logger.error('Redis connection not available - cannot start worker');
    process.exit(1);
  }

  // Create worker
  worker = new Worker<OcrJobData>(
    config.ocr.queueName,
    async (job: Job<OcrJobData>) => {
    const { jobId, receiptId } = job.data;

    logger.info(
      {
        jobId,
        receiptId,
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts,
      },
      'Processing OCR job'
    );

    try {
      // Update job status to PROCESSING
      const ocrJob = await OcrJob.findById(jobId);
      if (!ocrJob) {
        throw new Error(`OCR job ${jobId} not found`);
      }

      ocrJob.status = OcrJobStatus.PROCESSING;
      ocrJob.attempts = (ocrJob.attempts || 0) + 1;
      await ocrJob.save();

      // Process the OCR job
      await OcrService.processOcrJob(jobId);

      logger.info(
        {
          jobId,
          receiptId,
        },
        'OCR job completed successfully'
      );

      return { success: true, jobId };
    } catch (error: any) {
      logger.error(
        {
          jobId,
          receiptId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          attempt: job.attemptsMade + 1,
        },
        'OCR job processing failed'
      );

      // Update job status if it exists
      try {
        const ocrJob = await OcrJob.findById(jobId);
        if (ocrJob) {
          ocrJob.status = OcrJobStatus.FAILED;
          ocrJob.error = error instanceof Error ? error.message : String(error);
          ocrJob.attempts = (ocrJob.attempts || 0) + 1;
          await ocrJob.save();
        }
      } catch (updateError) {
        logger.error(
          {
            jobId,
            error: updateError,
          },
          'Failed to update OCR job status after failure'
        );
      }

      throw error; // Re-throw to trigger retry logic
    }
  },
  {
    connection: redisConnection,
    concurrency: config.ocr.concurrency,
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  }
);

// Worker event handlers
worker.on('completed', (job: Job) => {
  logger.info(
    {
      jobId: job.id,
      receiptId: job.data.receiptId,
    },
    'OCR job completed'
  );
});

worker.on('failed', (job: Job | undefined, error: Error) => {
  logger.error(
    {
      jobId: job?.id,
      receiptId: job?.data.receiptId,
      error: error.message,
      stack: error.stack,
    },
    'OCR job failed'
  );
});

worker.on('error', (error: Error) => {
  logger.error(
    {
      error: error.message,
      stack: error.stack,
    },
    'OCR worker error'
  );
});

// Graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  logger.info(
    {
      queueName: config.ocr.queueName,
      concurrency: config.ocr.concurrency,
      redisHost: config.redis.host,
      redisPort: config.redis.port,
    },
    'OCR worker started'
  );
};

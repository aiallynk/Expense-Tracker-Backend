import { Queue, QueueOptions } from 'bullmq';
import IORedis from 'ioredis';

import { logger } from './logger';

import { config } from './index';

// Redis connection state
let redisConnection: IORedis | null = null;
let ocrQueue: Queue | null = null;
let isRedisEnabled = false;
let redisInitialized = false;

// Check if Redis is needed for OCR queue
// Redis is only needed if OCR is not disabled
const isRedisNeeded = (): boolean => {
  // If OCR is disabled, Redis is not needed
  if (config.ocr.disableOcr) {
    return false;
  }
  // Redis is needed for OCR queue/worker functionality
  // When initializeRedisIfNeeded is called, it means Redis is needed
  return true;
};

// Create Redis connection with retry logic and graceful error handling
// Only creates the connection object, doesn't connect immediately
const createRedisConnection = (): IORedis => {
  const connection = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Retry connection with exponential backoff - stop after 3 retries in development
    retryStrategy: (times: number) => {
      const maxRetries = config.app.env === 'development' ? 3 : 10;
      if (times > maxRetries) {
        // After max retries, give up and disable Redis
        if (times === maxRetries + 1) {
          // Only log once when we stop retrying
          if (config.app.env === 'development') {
            logger.warn(
              {
                host: config.redis.host,
                port: config.redis.port,
                retries: times - 1,
              },
              'Redis connection failed - OCR queue disabled (development mode)'
            );
          } else {
            logger.warn(
              {
                host: config.redis.host,
                port: config.redis.port,
                retries: times - 1,
              },
              'Redis connection failed after multiple retries. OCR queue will be disabled.'
            );
          }
          isRedisEnabled = false;
        }
        return null; // Stop retrying
      }
      // Exponential backoff: 100ms, 200ms, 400ms, etc.
      const delay = Math.min(100 * Math.pow(2, times - 1), 3000);
      return delay;
    },
    // Lazy connect - don't connect immediately
    lazyConnect: true,
    // Suppress connection errors in development
    showFriendlyErrorStack: false,
  });

  // Handle Redis connection events
  connection.on('connect', () => {
    logger.info({ host: config.redis.host, port: config.redis.port }, 'Redis connected');
    isRedisEnabled = true;
  });

  // Track if we've already logged the Redis unavailable message
  let hasLoggedUnavailable = false;

  connection.on('error', (error: Error) => {
    const errorCode = (error as any).code;
    
    // In development, suppress repeated connection errors after initial warning
    if (config.app.env === 'development') {
      if (!hasLoggedUnavailable && (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND')) {
        hasLoggedUnavailable = true;
        logger.warn(
          {
            host: config.redis.host,
            port: config.redis.port,
            error: { code: errorCode },
          },
          'Redis not available - OCR queue disabled (development mode)'
        );
        isRedisEnabled = false;
      }
      // Silently ignore subsequent connection errors in development
      return;
    }
    
    // In production, log all errors
    logger.error(
      {
        error: {
          code: errorCode,
          message: error.message,
        },
        host: config.redis.host,
        port: config.redis.port,
      },
      'Redis connection error'
    );
  });

  connection.on('close', () => {
    // Only log close events in production or if Redis was previously connected
    if (config.app.env !== 'development' || isRedisEnabled) {
      logger.info({ host: config.redis.host, port: config.redis.port }, 'Redis connection closed');
    }
  });

  connection.on('ready', () => {
    logger.info({ host: config.redis.host, port: config.redis.port }, 'Redis ready');
    isRedisEnabled = true;
  });

  return connection;
};

// Initialize Redis connection only if needed
// This function should be called explicitly when Redis is actually needed (e.g., OCR worker)
const initializeRedisIfNeeded = async (): Promise<boolean> => {
  // If already initialized, return current status
  if (redisInitialized) {
    return isRedisEnabled && redisConnection?.status === 'ready';
  }

  // Check if Redis is needed
  if (!isRedisNeeded()) {
    logger.info('Redis not needed - OCR is disabled');
    return false;
  }

  // Initialize Redis connection
  redisInitialized = true;
  logger.info(
    {
      host: config.redis.host,
      port: config.redis.port,
    },
    'Initializing Redis connection for OCR queue'
  );
  
  redisConnection = createRedisConnection();

  // Attempt to connect (non-blocking)
  // Connection will happen asynchronously, errors are handled by event handlers
  try {
    await redisConnection.connect();
    // Connection is asynchronous, so we return true and let event handlers manage state
    // The connection will be ready when the 'ready' event fires
    return true;
  } catch (error: any) {
    // Connection errors are handled by the error event handler
    // Log error but don't fail completely in development
    if (config.app.env !== 'development') {
      logger.error(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        'Failed to initiate Redis connection'
      );
    }
    isRedisEnabled = false;
    return false;
  }
};

// Don't initialize Redis by default - only when needed
// This prevents connection errors when Redis is not available and not needed

// Create OCR queue lazily - only when Redis is initialized and available
const createOcrQueue = (): Queue | null => {
  if (!redisConnection) {
    return null;
  }

  const queueOptions: QueueOptions = {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: {
        age: 24 * 3600, // Keep completed jobs for 24 hours
        count: 1000,
      },
      removeOnFail: {
        age: 7 * 24 * 3600, // Keep failed jobs for 7 days
      },
    },
  };

  try {
    return new Queue(config.ocr.queueName, queueOptions);
  } catch (error) {
    logger.warn({ error }, 'Failed to create OCR queue - Redis may not be available');
    return null;
  }
};

// Get OCR queue - creates it if Redis is available
const getOcrQueue = (): Queue | null => {
  if (!ocrQueue && redisConnection && isRedisEnabled) {
    ocrQueue = createOcrQueue();
  }
  return ocrQueue;
};

// Export connection and queue (may be null if Redis is unavailable)
export { redisConnection, ocrQueue, isRedisEnabled, initializeRedisIfNeeded, getOcrQueue };

// Helper function to check if Redis is available
export const isRedisAvailable = (): boolean => {
  return isRedisEnabled && redisConnection?.status === 'ready';
};

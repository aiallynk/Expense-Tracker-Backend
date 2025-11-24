import pino from 'pino';

/**
 * Production-ready logger using pino
 * - Structured JSON logs by default
 * - Human-readable format in development (when LOG_PRETTY=true)
 * - Request ID support via child loggers
 * - Log levels: debug, info, warn, error
 * 
 * Note: Reads directly from process.env to avoid circular dependency with config
 */
const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as pino.Level;

// Validate log level
const validLevels: pino.Level[] = ['debug', 'info', 'warn', 'error', 'fatal'];
const level = validLevels.includes(logLevel) ? logLevel : 'info';

// Base logger configuration
const loggerConfig: pino.LoggerOptions = {
  level,
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact sensitive information
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'secret',
      'token',
      'accessKey',
      'secretKey',
      'apiKey',
      'privateKey',
      'presignedUrl',
      'uploadUrl',
      'downloadUrl',
      'refreshToken',
      'authorization',
    ],
    remove: true,
  },
};

// Use pretty printing in development if LOG_PRETTY=true
const isPretty = process.env.LOG_PRETTY === 'true' || process.env.APP_ENV === 'development';

const baseLogger = isPretty
  ? pino(
      {
        ...loggerConfig,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      },
      pino.destination({ sync: false })
    )
  : pino(loggerConfig, pino.destination({ sync: false }));

/**
 * Main logger instance
 * Use logger.info(), logger.error(), etc. for application logs
 * Use logger.child({ requestId: 'xxx' }) to create request-scoped loggers
 */
export const logger = baseLogger;

/**
 * Create a child logger with request ID for request-scoped logging
 * @param requestId - Request ID from X-Request-ID header or generated UUID
 * @returns Child logger with requestId in context
 */
export const createRequestLogger = (requestId: string): pino.Logger => {
  return baseLogger.child({ requestId });
};

/**
 * Log levels:
 * - debug: Detailed debugging information (only in development/debug mode)
 * - info: General informational messages (server start, DB connected, etc.)
 * - warn: Warning messages (deprecations, recoverable errors)
 * - error: Error messages (exceptions, failures)
 * - fatal: Critical errors that cause application shutdown
 */


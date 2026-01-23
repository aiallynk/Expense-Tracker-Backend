import pino from 'pino';

/**
 * Production-ready logger using pino
 * - Structured JSON logs by default
 * - Human-readable format in development (when LOG_PRETTY=true)
 * - Request ID support via child loggers
 * - Log levels: debug, info, warn, error
 * 
 * Note: Reads directly from process.env to avoid circular dependency with config
 * In production: Only ERROR and WARN logs are shown (INFO and DEBUG suppressed)
 * 
 * Log Rotation:
 * - Logger writes to stdout/stderr (captured by PM2)
 * - PM2 handles log rotation via pm2-logrotate module
 * - Configuration: max_size=10MB, retain=3 files
 * - Setup: pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 10M && pm2 set pm2-logrotate:retain 3
 */
// Check if production environment
const isProduction = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';

// Determine log level: suppress INFO in production unless explicitly set
const logLevelEnv = process.env.LOG_LEVEL?.toLowerCase() as pino.Level | undefined;
let logLevel: pino.Level;

if (logLevelEnv) {
  // Use explicit LOG_LEVEL if set
  logLevel = logLevelEnv;
} else if (isProduction) {
  // Production default: only WARN and ERROR
  logLevel = 'warn';
} else {
  // Development default: INFO
  logLevel = 'info';
}

// Validate log level
const validLevels: pino.Level[] = ['debug', 'info', 'warn', 'error', 'fatal'];
const level = validLevels.includes(logLevel) ? logLevel : (isProduction ? 'warn' : 'info');

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


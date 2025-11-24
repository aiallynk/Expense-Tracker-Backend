# Logging Policy

This document describes the logging policy for the Expense Tracker Backend application.

## Overview

The application uses [pino](https://getpino.io/) for structured JSON logging. Logs are JSON by default for production, with human-readable format available in development when `LOG_PRETTY=true`.

## Log Levels

### `debug`
**When to use:** Detailed debugging information, verbose execution traces, detailed request/response data.

**Examples:**
- Function entry/exit points
- Detailed validation steps
- Request body contents (sanitized)
- Database query details
- Step-by-step processing information

**Visibility:** Only when `LOG_LEVEL=debug`

### `info`
**When to use:** General informational messages about application flow, successful operations, important state changes.

**Examples:**
- Server startup/shutdown
- Database connection established
- Successful authentication
- Job processing started/completed
- Periodic service updates
- Health check status

**Visibility:** Default level

### `warn`
**When to use:** Warning messages for recoverable errors, deprecations, configuration issues, or unexpected but handled situations.

**Examples:**
- Database connection retries
- Missing optional configuration
- Rate limit approaching
- Validation failures (non-critical)
- Service degradation (fallback used)

**Visibility:** Default level

### `error`
**When to use:** Error messages for failures, exceptions, and critical issues that require attention.

**Examples:**
- Unhandled exceptions
- Database connection failures
- Authentication failures
- Job processing failures
- External API errors
- Validation errors (critical)

**Visibility:** Default level

### `fatal`
**When to use:** Critical errors that cause application shutdown or prevent startup.

**Examples:**
- Environment variable validation failures
- Critical service initialization failures
- Unrecoverable database errors

**Visibility:** Always logged

## Structured Logging

All logs use structured JSON format with contextual information:

```typescript
logger.info({ userId, action: 'login' }, 'User logged in');
logger.error({ error, jobId, receiptId }, 'OCR job failed');
logger.warn({ bucketName }, 'S3 bucket access denied, assuming exists');
```

## Request ID Correlation

All requests include a `requestId` for correlation:

```typescript
// Middleware adds requestId to request
const requestLogger = (req as any).logger; // Request-scoped logger
requestLogger.info({ userId }, 'Processing request');
```

## Sensitive Data Redaction

The following fields are automatically redacted from logs:
- `req.headers.authorization`
- `req.headers.cookie`
- `password`
- `secret`
- `token`
- `accessKey`
- `secretKey`
- `apiKey`
- `privateKey`
- `presignedUrl`
- `uploadUrl`
- `downloadUrl`

**Never log:**
- Full presigned URLs (log only bucket/key)
- JWT tokens (log only token metadata)
- Passwords (even hashed)
- AWS credentials
- API keys
- Private keys

## Logging Best Practices

1. **Use appropriate log levels** - Don't use `error` for expected failures
2. **Include context** - Add relevant IDs, timestamps, and metadata
3. **Use structured logging** - Always use object format: `logger.info({ key: value }, 'message')`
4. **Avoid logging sensitive data** - Use redaction or sanitization
5. **Log at boundaries** - Log at service boundaries (API calls, DB queries, external services)
6. **Log errors with stack traces** - Include error objects with stack traces
7. **Use request-scoped loggers** - Use `req.logger` for request correlation
8. **Don't log in tight loops** - Avoid logging in performance-critical loops

## Examples

### Good Logging

```typescript
// ✅ Good: Structured, contextual, appropriate level
logger.info({ userId, expenseId }, 'Expense created');
logger.error({ error, jobId }, 'OCR job failed');
logger.debug({ requestId, path: req.path }, 'Processing request');

// ✅ Good: Request-scoped logger
const requestLogger = (req as any).logger;
requestLogger.info({ userId }, 'User authenticated');
```

### Bad Logging

```typescript
// ❌ Bad: No structure, no context
logger.info('Expense created');
logger.error('Error occurred');

// ❌ Bad: Logging sensitive data
logger.info({ presignedUrl: url }, 'Generated presigned URL');
logger.info({ password: hash }, 'Password hashed');

// ❌ Bad: Wrong log level
logger.error({ userId }, 'User logged in'); // Should be info
logger.info({ error }, 'Database connection failed'); // Should be error

// ❌ Bad: Too verbose in production
logger.debug({ fullRequest: req.body }, 'Request received'); // Only in debug mode
```

## Environment Configuration

- `LOG_LEVEL`: Set log level (debug, info, warn, error, fatal). Default: `info`
- `LOG_PRETTY`: Enable human-readable logs (true/false). Default: `false`
- `REQUEST_ID_HEADER`: Header name for request ID. Default: `X-Request-ID`

## Production Considerations

1. **JSON logs** - Use structured JSON logs for log aggregation tools (Datadog, Loggly, etc.)
2. **Log rotation** - Configure log rotation to prevent disk space issues
3. **Log retention** - Set appropriate retention policies
4. **Monitoring** - Set up alerts for error rate, fatal logs
5. **Performance** - Use async logging (pino default) to avoid blocking
6. **Sampling** - Consider sampling debug logs in high-traffic scenarios

## Migration from console.log

All `console.log`, `console.error`, `console.warn`, `console.debug` calls have been replaced with appropriate logger calls:

- `console.log` → `logger.info` or `logger.debug`
- `console.error` → `logger.error`
- `console.warn` → `logger.warn`
- `console.debug` → `logger.debug`


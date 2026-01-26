import { Response } from 'express';

import { config } from '../config/index';
import { logger } from '../config/logger';
import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';

export class IngestController {
  static ingest = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Security: Block in production unless explicitly enabled
    if (config.app.env === 'production' && !config.ingest.enabled) {
      logger.warn(
        {
          sessionId: req.params.sessionId,
          userId: req.user?.id,
          ip: req.ip,
        },
        'Ingest endpoint blocked in production'
      );
      res.status(403).json({
        success: false,
        message: 'Ingest endpoint is disabled in production',
        code: 'INGEST_DISABLED',
      });
      return;
    }

    const { sessionId } = req.params;
    const ingestData = req.body;

    // Validate session ID format (UUID)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!sessionId || !uuidRegex.test(sessionId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid session ID format',
        code: 'INVALID_SESSION_ID',
      });
      return;
    }

    // Validate request body
    if (!ingestData || typeof ingestData !== 'object') {
      res.status(400).json({
        success: false,
        message: 'Invalid request body',
        code: 'INVALID_BODY',
      });
      return;
    }

    try {
      // Forward request to local ingest service
      const ingestServiceUrl = config.ingest.serviceUrl;
      const forwardUrl = `${ingestServiceUrl}/ingest/${sessionId}`;

      logger.debug(
        {
          sessionId,
          forwardUrl,
          userId: req.user?.id,
        },
        'Forwarding ingest request to local service'
      );

      // Forward the request to local ingest service using native fetch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const response = await fetch(forwardUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ingestData),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let responseData: any = null;
      if (response.ok) {
        try {
          responseData = await response.json();
        } catch {
          // If response is not JSON, that's okay
          responseData = { message: 'Request forwarded successfully' };
        }
      }

      // Return success response
      res.status(200).json({
        success: true,
        message: 'Data ingested successfully',
        data: responseData,
      });
    } catch (error: any) {
      // Log error but don't fail the request (debug logging should be non-blocking)
      logger.error(
        {
          sessionId,
          error: error.message,
          code: error.code,
          userId: req.user?.id,
        },
        'Failed to forward ingest request'
      );

      // Return success anyway (debug logging should not block user operations)
      // The frontend already uses .catch() to handle failures silently
      res.status(200).json({
        success: true,
        message: 'Ingest request received (forwarding may have failed)',
      });
    }
  });
}

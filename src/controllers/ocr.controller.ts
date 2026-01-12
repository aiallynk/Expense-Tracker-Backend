import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { OcrService } from '../services/ocr.service';

export class OcrController {
  static getJobStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
    const jobId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = await OcrService.getOcrJobStatus(jobId);

    if (!job) {
      res.status(404).json({
        success: false,
        message: 'OCR job not found',
        code: 'OCR_JOB_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: job,
    });
  });
}


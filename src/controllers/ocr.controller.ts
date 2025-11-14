import { Response } from 'express';
import { OcrService } from '../services/ocr.service';
import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';

export class OcrController {
  static getJobStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
    const job = await OcrService.getOcrJobStatus(req.params.id);

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


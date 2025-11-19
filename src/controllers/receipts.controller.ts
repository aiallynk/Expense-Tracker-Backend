import { Response } from 'express';
import { ReceiptsService } from '../services/receipts.service';
import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { uploadIntentSchema } from '../utils/dtoTypes';

export class ReceiptsController {
  static createUploadIntent = asyncHandler(
    async (req: AuthRequest, res: Response) => {
      const data = uploadIntentSchema.parse(req.body);
      const result = await ReceiptsService.createUploadIntent(
        req.params.expenseId,
        req.user!.id,
        data
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    }
  );

  static confirmUpload = asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await ReceiptsService.confirmUpload(
      req.params.receiptId,
      req.user!.id
    );

    res.status(200).json({
      success: true,
      data: result.receipt,
      extractedFields: result.extractedFields,
      ocrJobId: result.ocrJobId,
      message: 'Receipt uploaded and OCR processing started',
    });
  });

  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const receipt = await ReceiptsService.getReceipt(
      req.params.id,
      req.user!.id,
      req.user!.role
    );

    if (!receipt) {
      res.status(404).json({
        success: false,
        message: 'Receipt not found',
        code: 'RECEIPT_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: receipt,
    });
  });
}


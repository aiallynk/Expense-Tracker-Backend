import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ReceiptsService } from '../services/receipts.service';
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
        data: {
          receiptId: result.receiptId,
          presignedUrl: result.uploadUrl,
          storageKey: result.storageKey,
          expiresIn: 3600,
        },
      });
    }
  );

  static confirmUpload = asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await ReceiptsService.confirmUpload(
      req.params.receiptId,
      req.user!.id
    );

    // Convert receipt to plain object to include all fields
    const receiptObj = (result.receipt as any).toObject ? (result.receipt as any).toObject() : result.receipt;
    
    res.status(200).json({
      success: true,
      data: {
        receiptId: (result.receipt._id as any).toString(),
        ocrJobId: result.ocrJobId,
        extractedFields: result.extractedFields || null,
        receipt: receiptObj, // Include full receipt object with signedUrl if available
      },
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


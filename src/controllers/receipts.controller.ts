import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ReceiptsService } from '../services/receipts.service';
import { uploadIntentSchema } from '../utils/dtoTypes';

export class ReceiptsController {
  static createUploadIntent = asyncHandler(
    async (req: AuthRequest, res: Response) => {
      const data = uploadIntentSchema.parse(req.body);
      const expenseId = Array.isArray(req.params.expenseId) ? req.params.expenseId[0] : req.params.expenseId;
      const result = await ReceiptsService.createUploadIntent(
        expenseId,
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
    const receiptId = Array.isArray(req.params.receiptId) ? req.params.receiptId[0] : req.params.receiptId;
    const result = await ReceiptsService.confirmUpload(
      receiptId,
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
    try {
      const receiptId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const receipt = await ReceiptsService.getReceipt(
        receiptId,
        req.user!.id,
        req.user!.role
      );

      res.status(200).json({
        success: true,
        data: receipt,
      });
    } catch (error: any) {
      if (error.message === 'Receipt not found' || error.message === 'Invalid receipt ID format') {
        res.status(404).json({
          success: false,
          message: error.message,
          code: 'RECEIPT_NOT_FOUND',
        });
        return;
      }
      if (error.message === 'Access denied') {
        res.status(403).json({
          success: false,
          message: 'Access denied',
          code: 'ACCESS_DENIED',
        });
        return;
      }
      // Re-throw other errors to be handled by error middleware
      throw error;
    }
  });

  static uploadFile = asyncHandler(async (req: AuthRequest, res: Response) => {
    const receiptId = Array.isArray(req.params.receiptId) ? req.params.receiptId[0] : req.params.receiptId;
    
    // Handle multer file upload (disk storage)
    const file = (req as any).file;
    
    if (!file) {
      res.status(400).json({
        success: false,
        message: 'No file provided',
        code: 'NO_FILE',
      });
      return;
    }

    if (!file.path) {
      res.status(400).json({
        success: false,
        message: 'File path not available',
        code: 'INVALID_FILE',
      });
      return;
    }

    const mimeType = file.mimetype || 'application/octet-stream';

    try {
      await ReceiptsService.uploadFile(
        receiptId,
        req.user!.id,
        file.path,
        mimeType
      );

      res.status(200).json({
        success: true,
        message: 'File uploaded successfully',
      });
    } catch (error) {
      // Ensure temp file is deleted even if upload fails
      if (file.path) {
        try {
          const fs = await import('fs');
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } catch (deleteError) {
          // Ignore delete errors
        }
      }
      throw error;
    }
  });
}


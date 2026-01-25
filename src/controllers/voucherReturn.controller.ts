import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { VoucherReturnService } from '../services/voucherReturn.service';
import { VoucherReturnRequestStatus } from '../models/VoucherReturnRequest';
import { getUserCompanyId } from '../utils/companyAccess';
import { UserRole } from '../utils/enums';

export class VoucherReturnController {
  /**
   * Request return of unused voucher balance
   * POST /api/v1/voucher-returns
   */
  static requestReturn = asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { voucherId, returnAmount, reason } = req.body;

    if (!voucherId || !returnAmount) {
      res.status(400).json({
        success: false,
        message: 'voucherId and returnAmount are required',
        code: 'MISSING_FIELDS',
      });
      return;
    }

    const returnRequest = await VoucherReturnService.requestReturn({
      voucherId,
      userId,
      returnAmount,
      reason,
    });

    res.status(201).json({
      success: true,
      data: returnRequest,
    });
  });

  /**
   * List return requests
   * GET /api/v1/voucher-returns
   */
  static list = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const actorId = req.user!.id;
    const actorRole = req.user!.role;

    if (!companyId) {
      res.status(200).json({ success: true, data: { requests: [], total: 0 } });
      return;
    }

    const status = typeof req.query.status === 'string' ? req.query.status as VoucherReturnRequestStatus : undefined;
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const voucherId = typeof req.query.voucherId === 'string' ? req.query.voucherId : undefined;
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
    const skip = typeof req.query.skip === 'string' ? parseInt(req.query.skip, 10) : 0;

    // Users can only see their own requests, admins can see all
    const targetUserId = actorRole === UserRole.COMPANY_ADMIN || actorRole === UserRole.ADMIN
      ? userId
      : actorId;

    const result = await VoucherReturnService.getReturnRequests({
      companyId,
      status,
      userId: targetUserId,
      voucherId,
      limit,
      skip,
    });

    res.status(200).json({
      success: true,
      data: result.requests,
      pagination: {
        total: result.total,
        limit,
        skip,
      },
    });
  });

  /**
   * Approve return request (Admin only)
   * POST /api/v1/voucher-returns/:id/approve
   */
  static approve = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const adminId = req.user!.id;
    const actorRole = req.user!.role;

    // Only COMPANY_ADMIN and ADMIN can approve returns
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN) {
      res.status(403).json({
        success: false,
        message: 'You do not have permission to approve return requests',
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      return;
    }

    const { comment } = req.body;

    const returnRequest = await VoucherReturnService.approveReturn({
      requestId,
      adminId,
      comment,
    });

    res.status(200).json({
      success: true,
      data: returnRequest,
    });
  });

  /**
   * Reject return request (Admin only)
   * POST /api/v1/voucher-returns/:id/reject
   */
  static reject = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const adminId = req.user!.id;
    const actorRole = req.user!.role;

    // Only COMPANY_ADMIN and ADMIN can reject returns
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN) {
      res.status(403).json({
        success: false,
        message: 'You do not have permission to reject return requests',
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      return;
    }

    const { comment } = req.body;

    if (!comment) {
      res.status(400).json({
        success: false,
        message: 'comment is required for rejection',
        code: 'MISSING_COMMENT',
      });
      return;
    }

    const returnRequest = await VoucherReturnService.rejectReturn({
      requestId,
      adminId,
      comment,
    });

    res.status(200).json({
      success: true,
      data: returnRequest,
    });
  });

  /**
   * Direct admin return of voucher (bypasses return request workflow)
   * POST /api/v1/vouchers/:id/admin-return
   */
  static adminReturn = asyncHandler(async (req: AuthRequest, res: Response) => {
    const voucherId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const adminId = req.user!.id;
    const actorRole = req.user!.role;

    // Only COMPANY_ADMIN and ADMIN can directly return vouchers
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN && actorRole !== UserRole.SUPER_ADMIN) {
      res.status(403).json({
        success: false,
        message: 'You do not have permission to directly return vouchers',
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      return;
    }

    const { returnAmount, comment } = req.body;

    if (!returnAmount) {
      res.status(400).json({
        success: false,
        message: 'returnAmount is required',
        code: 'MISSING_FIELDS',
      });
      return;
    }

    const voucher = await VoucherReturnService.adminReturnVoucher({
      voucherId,
      adminId,
      returnAmount: Number(returnAmount),
      comment,
    });

    res.status(200).json({
      success: true,
      data: voucher,
    });
  });
}

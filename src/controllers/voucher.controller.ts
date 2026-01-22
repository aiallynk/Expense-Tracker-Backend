import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { VoucherService } from '../services/voucher.service';
import { getUserCompanyId } from '../utils/companyAccess';
import { UserRole } from '../utils/enums';

export class VoucherController {
  /**
   * Create voucher (Admin only)
   * POST /api/v1/vouchers
   */
  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const actorId = req.user!.id;
    const actorRole = req.user!.role;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    // Only COMPANY_ADMIN and ADMIN can create vouchers
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN) {
      res.status(403).json({
        success: false,
        message: 'You do not have permission to create vouchers',
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      return;
    }

    const { employeeId, totalAmount, currency, projectId, costCentreId, voucherCode } = req.body;

    if (!employeeId || !totalAmount) {
      res.status(400).json({
        success: false,
        message: 'employeeId and totalAmount are required',
        code: 'MISSING_FIELDS',
      });
      return;
    }

    const voucher = await VoucherService.createVoucher({
      companyId,
      employeeId,
      totalAmount,
      currency,
      projectId,
      costCentreId,
      voucherCode,
      createdBy: actorId,
    });

    res.status(201).json({
      success: true,
      data: voucher,
    });
  });

  /**
   * List vouchers (Admin - all company vouchers, User - own vouchers)
   * GET /api/v1/vouchers
   */
  static list = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const actorId = req.user!.id;
    const actorRole = req.user!.role;

    if (!companyId) {
      res.status(200).json({ success: true, data: [] });
      return;
    }

    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    // Admins can list all vouchers, users can only see their own
    const targetEmployeeId = actorRole === UserRole.COMPANY_ADMIN || actorRole === UserRole.ADMIN
      ? (employeeId || actorId)
      : actorId;

    const { AdvanceCash } = await import('../models/AdvanceCash');
    const query: any = {
      companyId: companyId,
      employeeId: targetEmployeeId,
    };

    if (status) {
      query.status = status;
    }

    const vouchers = await AdvanceCash.find(query)
      .sort({ createdAt: -1 })
      .populate('employeeId', 'name email')
      .populate('projectId', 'name code')
      .populate('costCentreId', 'name code')
      .populate('createdBy', 'name email')
      .exec();

    res.status(200).json({
      success: true,
      data: vouchers,
    });
  });

  /**
   * Get voucher details with usage history and ledger
   * GET /api/v1/vouchers/:id
   */
  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const voucherId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const companyId = await getUserCompanyId(req);
    const actorId = req.user!.id;
    const actorRole = req.user!.role;

    const details = await VoucherService.getVoucherDetails(voucherId);

    // Security check: Users can only view their own vouchers, admins can view any
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN) {
      if (details.voucher.employeeId.toString() !== actorId) {
        res.status(403).json({
          success: false,
          message: 'Access denied',
          code: 'ACCESS_DENIED',
        });
        return;
      }
    }

    // Verify company match
    if (details.voucher.companyId.toString() !== companyId) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
        code: 'ACCESS_DENIED',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: details,
    });
  });

  /**
   * Get voucher usage history
   * GET /api/v1/vouchers/:id/usage-history
   */
  static getUsageHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
    const voucherId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const companyId = await getUserCompanyId(req);
    const actorId = req.user!.id;
    const actorRole = req.user!.role;

    const { AdvanceCash } = await import('../models/AdvanceCash');
    const voucher = await AdvanceCash.findById(voucherId).exec();

    if (!voucher) {
      res.status(404).json({
        success: false,
        message: 'Voucher not found',
        code: 'VOUCHER_NOT_FOUND',
      });
      return;
    }

    // Security check
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN) {
      if (voucher.employeeId.toString() !== actorId) {
        res.status(403).json({
          success: false,
          message: 'Access denied',
          code: 'ACCESS_DENIED',
        });
        return;
      }
    }

    if (voucher.companyId.toString() !== companyId) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
        code: 'ACCESS_DENIED',
      });
      return;
    }

    const usageHistory = await VoucherService.getVoucherUsageHistory(voucherId);

    res.status(200).json({
      success: true,
      data: usageHistory,
    });
  });

  /**
   * Get voucher ledger entries
   * GET /api/v1/vouchers/:id/ledger
   */
  static getLedger = asyncHandler(async (req: AuthRequest, res: Response) => {
    const voucherId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const companyId = await getUserCompanyId(req);
    const actorId = req.user!.id;
    const actorRole = req.user!.role;

    const { AdvanceCash } = await import('../models/AdvanceCash');
    const voucher = await AdvanceCash.findById(voucherId).exec();

    if (!voucher) {
      res.status(404).json({
        success: false,
        message: 'Voucher not found',
        code: 'VOUCHER_NOT_FOUND',
      });
      return;
    }

    // Security check
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN) {
      if (voucher.employeeId.toString() !== actorId) {
        res.status(403).json({
          success: false,
          message: 'Access denied',
          code: 'ACCESS_DENIED',
        });
        return;
      }
    }

    if (voucher.companyId.toString() !== companyId) {
      res.status(403).json({
        success: false,
        message: 'Access denied',
        code: 'ACCESS_DENIED',
      });
      return;
    }

    const { LedgerService } = await import('../services/ledger.service');
    const ledgerEntries = await LedgerService.getVoucherLedger(voucherId);

    res.status(200).json({
      success: true,
      data: ledgerEntries,
    });
  });

  /**
   * Get voucher dashboard stats (Admin only)
   * GET /api/v1/vouchers/dashboard
   */
  static getDashboard = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const actorRole = req.user!.role;

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    // Only COMPANY_ADMIN and ADMIN can view dashboard
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN) {
      res.status(403).json({
        success: false,
        message: 'You do not have permission to view voucher dashboard',
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      return;
    }

    const dashboard = await VoucherService.getVoucherDashboard(companyId);

    res.status(200).json({
      success: true,
      data: dashboard,
    });
  });
}

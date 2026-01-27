import mongoose from 'mongoose';

import { AdvanceCash, AdvanceCashStatus, IAdvanceCash } from '../models/AdvanceCash';
import { VoucherReturnRequest, VoucherReturnRequestStatus, IVoucherReturnRequest } from '../models/VoucherReturnRequest';
import { User } from '../models/User';
import { AuditService } from './audit.service';
import { AuditAction } from '../utils/enums';
import { LedgerService } from './ledger.service';
import { LedgerEntryType } from '../models/Ledger';
import { VoucherService } from './voucher.service';

import { logger } from '@/config/logger';

export class VoucherReturnService {
  /**
   * Request return of unused voucher balance
   */
  static async requestReturn(params: {
    voucherId: string;
    userId: string;
    returnAmount: number;
    reason?: string;
  }): Promise<IVoucherReturnRequest> {
    if (!mongoose.Types.ObjectId.isValid(params.voucherId)) {
      throw new Error('Invalid voucher ID');
    }

    const voucherObjectId = new mongoose.Types.ObjectId(params.voucherId);
    const userObjectId = new mongoose.Types.ObjectId(params.userId);

    // Load voucher
    const voucher = await AdvanceCash.findById(voucherObjectId).exec();
    if (!voucher) {
      throw new Error('Voucher not found');
    }

    // Validate voucher belongs to user
    if (voucher.employeeId.toString() !== params.userId) {
      throw new Error('Access denied: Voucher does not belong to you');
    }

    // Validate return amount
    const returnAmount = Number(params.returnAmount);
    if (!isFinite(returnAmount) || returnAmount <= 0) {
      throw new Error('Return amount must be greater than 0');
    }

    if (returnAmount > voucher.remainingAmount) {
      throw new Error(`Return amount exceeds voucher balance. Available: ${voucher.remainingAmount} ${voucher.currency}`);
    }

    // Validate voucher status
    if (voucher.status === AdvanceCashStatus.EXHAUSTED) {
      throw new Error('Cannot return from an exhausted voucher');
    }

    if (voucher.status === AdvanceCashStatus.RETURNED) {
      throw new Error('Voucher has already been returned');
    }

    // Check for existing pending return request
    const existingRequest = await VoucherReturnRequest.findOne({
      voucherId: voucherObjectId,
      status: VoucherReturnRequestStatus.PENDING,
    }).exec();

    if (existingRequest) {
      throw new Error('A pending return request already exists for this voucher');
    }

    // Get company ID from user
    const user = await User.findById(userObjectId).select('companyId').exec();
    if (!user || !user.companyId) {
      throw new Error('User company not found');
    }

    // Create return request
    const returnRequest = new VoucherReturnRequest({
      voucherId: voucherObjectId,
      userId: userObjectId,
      companyId: user.companyId,
      returnAmount,
      currency: voucher.currency,
      reason: params.reason,
      status: VoucherReturnRequestStatus.PENDING,
      requestedBy: userObjectId,
    });

    const saved = await returnRequest.save();

    // Update voucher with return request reference
    voucher.returnRequestId = saved._id as mongoose.Types.ObjectId;
    await voucher.save();

    // Log audit entry
    await AuditService.log(
      params.userId,
      'VoucherReturnRequest',
      (saved._id as mongoose.Types.ObjectId).toString(),
      AuditAction.CREATE,
      {
        voucherId: params.voucherId,
        returnAmount,
        reason: params.reason,
      }
    );

    return saved;
  }

  /**
   * Approve return request (Admin only)
   */
  static async approveReturn(params: {
    requestId: string;
    adminId: string;
    comment?: string;
  }): Promise<IVoucherReturnRequest> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const requestObjectId = new mongoose.Types.ObjectId(params.requestId);
      const adminObjectId = new mongoose.Types.ObjectId(params.adminId);

      // Load return request
      const returnRequest = await VoucherReturnRequest.findById(requestObjectId)
        .session(session)
        .exec();

      if (!returnRequest) {
        throw new Error('Return request not found');
      }

      // Validate status
      if (returnRequest.status !== VoucherReturnRequestStatus.PENDING) {
        throw new Error(`Cannot approve return request in ${returnRequest.status} status`);
      }

      // Load voucher with lock
      const voucher = await AdvanceCash.findById(returnRequest.voucherId)
        .session(session)
        .exec();

      if (!voucher) {
        throw new Error('Voucher not found');
      }

      // Validate voucher still has sufficient balance
      if (returnRequest.returnAmount > voucher.remainingAmount) {
        throw new Error(`Voucher balance is insufficient for return. Available: ${voucher.remainingAmount} ${voucher.currency}`);
      }

      // Update return request
      returnRequest.status = VoucherReturnRequestStatus.APPROVED;
      returnRequest.reviewedAt = new Date();
      returnRequest.reviewedBy = adminObjectId;
      returnRequest.reviewerComment = params.comment;

      await returnRequest.save({ session });

      // Update voucher
      voucher.remainingAmount = voucher.remainingAmount - returnRequest.returnAmount;
      voucher.returnedAmount = (voucher.returnedAmount || 0) + returnRequest.returnAmount;
      // Enforce invariant: remainingAmount = totalAmount - usedAmount - returnedAmount
      voucher.remainingAmount = Math.max(
        0,
        (voucher.totalAmount ?? 0) - (voucher.usedAmount ?? 0) - voucher.returnedAmount
      );

      // If fully returned, mark as RETURNED
      if (voucher.remainingAmount === 0) {
        voucher.status = AdvanceCashStatus.RETURNED;
      } else {
        // Update status based on remaining amount
        voucher.status = VoucherService.calculateVoucherStatus(voucher);
      }

      await voucher.save({ session });

      // Create ledger entry
      try {
        const employee = await User.findById(returnRequest.userId)
          .select('name email')
          .session(session)
          .exec();
        const employeeName = (employee as any)?.name || (employee as any)?.email || 'Employee';

        await LedgerService.createEntry({
          companyId: returnRequest.companyId.toString(),
          entryType: LedgerEntryType.VOUCHER_RETURNED,
          voucherId: (voucher._id as mongoose.Types.ObjectId).toString(),
          userId: returnRequest.userId.toString(),
          amount: returnRequest.returnAmount, // Use return amount from request
          currency: voucher.currency,
          debitAccount: 'EMPLOYEE_ADVANCE',
          creditAccount: 'ADVANCE_CASH_PAID',
          description: `Voucher return approved for ${employeeName}${voucher.voucherCode ? ` (Voucher: ${voucher.voucherCode})` : ''}`,
          referenceId: voucher.voucherCode || (voucher._id as mongoose.Types.ObjectId).toString(),
          entryDate: new Date(),
          createdBy: params.adminId,
        });
      } catch (error) {
        logger.error({ error, requestId: params.requestId }, 'Failed to create ledger entry for voucher return');
        // Don't fail transaction if ledger entry fails
      }

      // Emit real-time update for voucher return (for liabilities update)
      try {
        const { emitVoucherUpdated, emitCompanyAdminDashboardUpdate } = await import('../socket/realtimeEvents');
        const companyId = returnRequest.companyId.toString();
        
        // Emit voucher updated event
        emitVoucherUpdated(companyId, {
          id: (voucher._id as mongoose.Types.ObjectId).toString(),
          _id: (voucher._id as mongoose.Types.ObjectId).toString(),
          remainingAmount: voucher.remainingAmount,
          returnedAmount: voucher.returnedAmount,
          usedAmount: voucher.usedAmount,
          status: voucher.status,
          returnedAt: voucher.returnedAt,
          returnedBy: voucher.returnedBy,
        });
        
        // Emit dashboard update to refresh liabilities in real-time
        try {
          const { CompanyAdminDashboardService } = await import('./companyAdminDashboard.service');
          const stats = await CompanyAdminDashboardService.getDashboardStatsForCompany(companyId);
          emitCompanyAdminDashboardUpdate(companyId, stats);
        } catch (dashboardError) {
          logger.error({ error: dashboardError, companyId }, 'Failed to emit dashboard update after voucher return approval');
        }
      } catch (error) {
        logger.error({ error, requestId: params.requestId }, 'Failed to emit voucher updated event');
        // Don't fail transaction if real-time update fails
      }

      // Log audit entry
      await AuditService.log(
        params.adminId,
        'VoucherReturnRequest',
        (returnRequest._id as mongoose.Types.ObjectId).toString(),
        AuditAction.STATUS_CHANGE,
        {
          status: VoucherReturnRequestStatus.APPROVED,
          voucherId: (voucher._id as mongoose.Types.ObjectId).toString(),
          returnAmount: returnRequest.returnAmount,
          comment: params.comment,
        }
      );

      await session.commitTransaction();

      return returnRequest;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Reject return request (Admin only)
   */
  static async rejectReturn(params: {
    requestId: string;
    adminId: string;
    comment: string;
  }): Promise<IVoucherReturnRequest> {
    if (!mongoose.Types.ObjectId.isValid(params.requestId)) {
      throw new Error('Invalid request ID');
    }

    const requestObjectId = new mongoose.Types.ObjectId(params.requestId);
    const adminObjectId = new mongoose.Types.ObjectId(params.adminId);

    // Load return request
    const returnRequest = await VoucherReturnRequest.findById(requestObjectId).exec();

    if (!returnRequest) {
      throw new Error('Return request not found');
    }

    // Validate status
    if (returnRequest.status !== VoucherReturnRequestStatus.PENDING) {
      throw new Error(`Cannot reject return request in ${returnRequest.status} status`);
    }

    // Update return request
    returnRequest.status = VoucherReturnRequestStatus.REJECTED;
    returnRequest.reviewedAt = new Date();
    returnRequest.reviewedBy = adminObjectId;
    returnRequest.reviewerComment = params.comment;

    await returnRequest.save();

    // Clear return request reference from voucher
    const voucher = await AdvanceCash.findById(returnRequest.voucherId).exec();
    if (voucher && voucher.returnRequestId?.toString() === params.requestId) {
      voucher.returnRequestId = undefined;
      await voucher.save();
    }

    // Log audit entry
    await AuditService.log(
      params.adminId,
      'VoucherReturnRequest',
      (returnRequest._id as mongoose.Types.ObjectId).toString(),
      AuditAction.STATUS_CHANGE,
      {
        status: VoucherReturnRequestStatus.REJECTED,
        voucherId: returnRequest.voucherId.toString(),
        comment: params.comment,
      }
    );

    return returnRequest;
  }

  /**
   * Get return requests (filtered by company, status, user, etc.)
   */
  static async getReturnRequests(params: {
    companyId: string;
    status?: VoucherReturnRequestStatus;
    userId?: string;
    voucherId?: string;
    limit?: number;
    skip?: number;
  }): Promise<{ requests: IVoucherReturnRequest[]; total: number }> {
    if (!mongoose.Types.ObjectId.isValid(params.companyId)) {
      throw new Error('Invalid company ID');
    }

    const query: any = {
      companyId: new mongoose.Types.ObjectId(params.companyId),
    };

    if (params.status) {
      query.status = params.status;
    }

    if (params.userId) {
      query.userId = new mongoose.Types.ObjectId(params.userId);
    }

    if (params.voucherId) {
      query.voucherId = new mongoose.Types.ObjectId(params.voucherId);
    }

    const total = await VoucherReturnRequest.countDocuments(query).exec();

    const requests = await VoucherReturnRequest.find(query)
      .populate('voucherId', 'voucherCode totalAmount remainingAmount currency status')
      .populate('userId', 'name email')
      .populate('requestedBy', 'name email')
      .populate('reviewedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(params.limit || 50)
      .skip(params.skip || 0)
      .exec();

    return { requests, total };
  }

  /**
   * Direct admin return of voucher (bypasses return request workflow)
   * Admin can directly mark remaining balance as returned
   */
  static async adminReturnVoucher(params: {
    voucherId: string;
    adminId: string;
    returnAmount: number;
    comment?: string;
  }): Promise<IAdvanceCash> {
    if (!mongoose.Types.ObjectId.isValid(params.voucherId)) {
      throw new Error('Invalid voucher ID');
    }

    if (!mongoose.Types.ObjectId.isValid(params.adminId)) {
      throw new Error('Invalid admin ID');
    }

    const voucherObjectId = new mongoose.Types.ObjectId(params.voucherId);
    const adminObjectId = new mongoose.Types.ObjectId(params.adminId);

    const returnAmount = Number(params.returnAmount);
    if (!isFinite(returnAmount) || returnAmount <= 0) {
      throw new Error('Return amount must be greater than 0');
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Load voucher with lock
      const voucher = await AdvanceCash.findById(voucherObjectId)
        .session(session)
        .exec();

      if (!voucher) {
        throw new Error('Voucher not found');
      }

      // Validate return amount
      if (returnAmount > voucher.remainingAmount) {
        throw new Error(
          `Return amount exceeds voucher balance. Available: ${voucher.remainingAmount} ${voucher.currency}`
        );
      }

      // Validate voucher status
      if (voucher.status === AdvanceCashStatus.EXHAUSTED) {
        throw new Error('Cannot return from an exhausted voucher');
      }

      if (voucher.status === AdvanceCashStatus.RETURNED) {
        throw new Error('Voucher is already fully returned');
      }

      // CRITICAL: When admin marks as returned, use the FULL remaining amount
      // This ensures remainingAmount becomes exactly 0
      // Get the actual remaining amount (handle both remainingAmount and legacy balance field)
      const currentRemaining = voucher.remainingAmount ?? voucher.balance ?? 0;
      const actualReturnAmount = returnAmount >= currentRemaining 
        ? currentRemaining 
        : returnAmount;

      // Update voucher - set remainingAmount to exactly 0 if returning full amount
      // CRITICAL: Ensure remainingAmount is set to exactly 0 when returning full amount
      voucher.remainingAmount = Math.max(0, currentRemaining - actualReturnAmount);
      // Sync legacy balance field
      voucher.balance = voucher.remainingAmount;
      voucher.returnedAmount = (voucher.returnedAmount || 0) + actualReturnAmount;
      voucher.returnedBy = adminObjectId;
      voucher.returnedAt = new Date();

      // If fully returned (remainingAmount is 0), mark as RETURNED
      if (voucher.remainingAmount === 0) {
        voucher.status = AdvanceCashStatus.RETURNED;
      } else {
        // Update status based on remaining amount
        voucher.status = VoucherService.calculateVoucherStatus(voucher);
      }
      
      // CRITICAL: Double-check that remainingAmount is exactly 0 if we returned the full amount
      if (actualReturnAmount >= currentRemaining && voucher.remainingAmount !== 0) {
        logger.warn(
          { 
            voucherId: params.voucherId, 
            currentRemaining, 
            actualReturnAmount, 
            remainingAfterReturn: voucher.remainingAmount 
          },
          'Remaining amount should be 0 after full return, forcing to 0'
        );
        voucher.remainingAmount = 0;
        voucher.balance = 0;
        voucher.status = AdvanceCashStatus.RETURNED;
      }

      await voucher.save({ session });

      // Create ledger entry
      try {
        const employee = await User.findById(voucher.employeeId)
          .select('name email')
          .session(session)
          .exec();
        const employeeName = (employee as any)?.name || (employee as any)?.email || 'Employee';

        await LedgerService.createEntry({
          companyId: voucher.companyId.toString(),
          entryType: LedgerEntryType.VOUCHER_RETURNED,
          voucherId: params.voucherId,
          userId: voucher.employeeId.toString(),
          amount: actualReturnAmount, // Use actual return amount (may be adjusted to full remaining)
          currency: voucher.currency,
          debitAccount: 'EMPLOYEE_ADVANCE',
          creditAccount: 'ADVANCE_CASH_PAID',
          description: `Voucher return by admin for ${employeeName}${voucher.voucherCode ? ` (Voucher: ${voucher.voucherCode})` : ''}${params.comment ? `. ${params.comment}` : ''}`,
          referenceId: voucher.voucherCode || params.voucherId,
          entryDate: new Date(),
          createdBy: params.adminId,
        });
      } catch (error) {
        logger.error({ error, voucherId: params.voucherId }, 'Failed to create ledger entry for admin return');
        // Don't fail transaction if ledger entry fails
      }

      // Log audit entry
      await AuditService.log(
        params.adminId,
        'AdvanceCash',
        params.voucherId,
        AuditAction.UPDATE,
        {
          action: 'ADMIN_RETURN',
          returnAmount: actualReturnAmount,
          requestedReturnAmount: returnAmount,
          remainingAmount: voucher.remainingAmount,
          status: voucher.status,
          comment: params.comment,
        }
      );

      await session.commitTransaction();

      logger.info(
        {
          voucherId: params.voucherId,
          returnAmount: actualReturnAmount,
          requestedReturnAmount: returnAmount,
          remainingAmount: voucher.remainingAmount,
          status: voucher.status,
        },
        'Admin return processed successfully'
      );

      // Emit real-time update for voucher return (for liabilities update)
      try {
        const { emitVoucherUpdated, emitCompanyAdminDashboardUpdate } = await import('../socket/realtimeEvents');
        const companyId = voucher.companyId.toString();
        
        // Emit voucher updated event
        emitVoucherUpdated(companyId, {
          id: (voucher._id as mongoose.Types.ObjectId).toString(),
          _id: (voucher._id as mongoose.Types.ObjectId).toString(),
          remainingAmount: voucher.remainingAmount,
          returnedAmount: voucher.returnedAmount,
          usedAmount: voucher.usedAmount,
          status: voucher.status,
          returnedAt: voucher.returnedAt,
          returnedBy: voucher.returnedBy,
        });
        
        // Emit dashboard update to refresh liabilities in real-time
        try {
          const { CompanyAdminDashboardService } = await import('./companyAdminDashboard.service');
          const stats = await CompanyAdminDashboardService.getDashboardStatsForCompany(companyId);
          emitCompanyAdminDashboardUpdate(companyId, stats);
        } catch (dashboardError) {
          logger.error({ error: dashboardError, companyId }, 'Failed to emit dashboard update after voucher return');
        }
      } catch (error) {
        logger.error({ error, voucherId: params.voucherId }, 'Failed to emit voucher updated event');
        // Don't fail transaction if real-time update fails
      }

      return voucher;
    } catch (error) {
      await session.abortTransaction();
      logger.error({ error, voucherId: params.voucherId }, 'Error processing admin return');
      throw error;
    } finally {
      session.endSession();
    }
  }
}

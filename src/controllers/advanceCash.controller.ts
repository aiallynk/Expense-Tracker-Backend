import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { User } from '../models/User';
import { AdvanceCashService } from '../services/advanceCash.service';
import { getUserCompanyId } from '../utils/companyAccess';
import { UserRole } from '../utils/enums';


export class AdvanceCashController {
  static getBalance = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const userId = req.user?.id;

    if (!companyId || !userId) {
      res.status(200).json({ success: true, data: { currency: 'INR', totalBalance: 0, scopedBalance: 0 } });
      return;
    }

    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const costCentreId = typeof req.query.costCentreId === 'string' ? req.query.costCentreId : undefined;
    const currency = typeof req.query.currency === 'string' ? req.query.currency : undefined;

    const data = await AdvanceCashService.getEmployeeAvailableBalance({
      companyId,
      employeeId: userId,
      currency,
      projectId,
      costCentreId,
    });

    res.status(200).json({ success: true, data });
  });

  static listMine = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const userId = req.user?.id;

    if (!companyId || !userId) {
      res.status(200).json({ success: true, data: [] });
      return;
    }

    const data = await AdvanceCashService.listEmployeeAdvances({ companyId, employeeId: userId });
    res.status(200).json({ success: true, data });
  });

  static getAvailableVouchers = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const userId = req.user?.id;

    if (!companyId || !userId) {
      res.status(200).json({ success: true, data: [] });
      return;
    }

    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const costCentreId = typeof req.query.costCentreId === 'string' ? req.query.costCentreId : undefined;
    const currency = typeof req.query.currency === 'string' ? req.query.currency : undefined;

    const data = await AdvanceCashService.getAvailableVouchers({
      companyId,
      employeeId: userId,
      currency,
      projectId,
      costCentreId,
    });
    res.status(200).json({ success: true, data });
  });

  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const actorId = req.user?.id;
    const actorRole = req.user?.role;
    
    if (!companyId || !actorId) {
      res.status(400).json({ success: false, message: 'User is not associated with a company', code: 'NO_COMPANY' });
      return;
    }

    // ONLY COMPANY_ADMIN and ADMIN can create advance cash vouchers
    // Regular employees/approvers cannot create vouchers - they can only view and request returns
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN) {
      res.status(403).json({
        success: false,
        message: 'You do not have permission to create advance cash vouchers. Only administrators can issue vouchers.',
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      return;
    }

    // Admins can create vouchers for any employee in their company
    const requestedEmployeeId = req.body.employeeId as string | undefined;
    let employeeId = actorId;

    if (requestedEmployeeId && requestedEmployeeId !== actorId) {
      // Creating for another employee
      if (!mongoose.Types.ObjectId.isValid(requestedEmployeeId)) {
        res.status(400).json({ success: false, message: 'Invalid employeeId', code: 'INVALID_EMPLOYEE' });
        return;
      }

      const employee = await User.findById(requestedEmployeeId).select('companyId').exec();
      if (!employee?.companyId || employee.companyId.toString() !== companyId) {
        res.status(403).json({ success: false, message: 'Employee not in your company', code: 'EMPLOYEE_NOT_IN_COMPANY' });
        return;
      }

      employeeId = requestedEmployeeId;
    }

    const created = await AdvanceCashService.createAdvance({
      companyId,
      employeeId,
      amount: req.body.amount,
      currency: req.body.currency,
      projectId: req.body.projectId,
      costCentreId: req.body.costCentreId,
      createdBy: actorId,
    });

    res.status(201).json({ success: true, data: created });
  });

  /**
   * List all advance cash entries for a company (company admin only)
   */
  static listCompany = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const actorRole = req.user?.role;

    if (!companyId) {
      res.status(400).json({ success: false, message: 'User is not associated with a company', code: 'NO_COMPANY' });
      return;
    }

    // Only COMPANY_ADMIN and ADMIN can list all advances for a company
    if (actorRole !== UserRole.COMPANY_ADMIN && actorRole !== UserRole.ADMIN) {
      res.status(403).json({
        success: false,
        message: 'You do not have permission to list all advance cash entries',
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      return;
    }

    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    const data = await AdvanceCashService.listCompanyAdvances({
      companyId,
      employeeId,
      status,
    });

    res.status(200).json({ success: true, data });
  });

  /**
   * Delete an advance cash voucher
   * - Users can delete their own vouchers
   * - Admins can delete any voucher in their company
   * - Cannot delete if voucher is used in any reports or transactions
   */
  static delete = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const userId = req.user?.id;
    const userRole = req.user?.role;

    if (!companyId || !userId) {
      res.status(400).json({ success: false, message: 'User is not associated with a company', code: 'NO_COMPANY' });
      return;
    }

    const advanceCashId = req.params.id;
    if (!advanceCashId) {
      res.status(400).json({ success: false, message: 'Advance cash ID is required', code: 'MISSING_ID' });
      return;
    }

    try {
      await AdvanceCashService.deleteAdvance({
        advanceCashId,
        companyId,
        userId,
        userRole: userRole || '',
      });

      res.status(200).json({ success: true, message: 'Advance cash voucher deleted successfully' });
    } catch (error: any) {
      const statusCode = error.message.includes('not found') ? 404 : 
                        error.message.includes('permission') || error.message.includes('only delete') ? 403 :
                        error.message.includes('Cannot delete') ? 400 : 500;
      
      res.status(statusCode).json({
        success: false,
        message: error.message || 'Failed to delete advance cash voucher',
        code: 'DELETE_FAILED',
      });
    }
  });
}



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

  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getUserCompanyId(req);
    const actorId = req.user?.id;
    if (!companyId || !actorId) {
      res.status(400).json({ success: false, message: 'User is not associated with a company', code: 'NO_COMPANY' });
      return;
    }

    // Employees can create advances only for themselves.
    // COMPANY_ADMIN / ADMIN can create for any employee in their company.
    const requestedEmployeeId = req.body.employeeId as string | undefined;
    let employeeId = actorId;

    const actorRole = req.user?.role;
    const canCreateForOthers = actorRole === UserRole.COMPANY_ADMIN || actorRole === UserRole.ADMIN;
    if (requestedEmployeeId && canCreateForOthers) {
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
}



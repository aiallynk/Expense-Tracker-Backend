import { Request, Response } from 'express';

import type { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { User } from '../models/User';
import { EmployeeApprovalProfileService } from '../services/EmployeeApprovalProfileService';

// Admin route prefix: /api/v1/employee-approval-profiles
export class EmployeeApprovalProfileController {
  private static async resolveRequesterCompanyId(req: Request): Promise<string | null> {
    const authReq = req as AuthRequest;

    // Prefer companyId from JWT (fast path)
    if (authReq.user?.companyId) return authReq.user.companyId;

    const requesterId = authReq.user?.id;
    if (!requesterId) return null;

    // Company admin tokens may reference CompanyAdmin collection, not User
    let requester: any = await User.findById(requesterId).select('companyId').exec();
    if (!requester) {
      requester = await CompanyAdmin.findById(requesterId).select('companyId').exec();
    }

    return requester?.companyId ? requester.companyId.toString() : null;
  }

  // GET /company (list active profiles for this company)
  static listCompanyActive = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const requesterId = (req as any).user?.id;
    if (!requesterId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const companyIdString = await EmployeeApprovalProfileController.resolveRequesterCompanyId(req);
    if (!companyIdString) {
      res.status(400).json({ success: false, message: 'CompanyId not found for requester' });
      return;
    }

    const profiles = await EmployeeApprovalProfileService.listActiveForCompany(companyIdString);
    res.json({ success: true, data: profiles });
  });

  // GET (fetch profile for employee)
  static get = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.query;
    if (!userId) {
      res.status(400).json({ success: false, message: 'userId required' });
      return;
    }
    const requesterId = (req as any).user?.id;
    if (!requesterId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const companyIdString = await EmployeeApprovalProfileController.resolveRequesterCompanyId(req);
    if (!companyIdString) {
      res.status(400).json({ success: false, message: 'CompanyId not found for requester' });
      return;
    }

    const profile = await EmployeeApprovalProfileService.getActive(String(userId), companyIdString);
    res.json({ success: true, data: profile });
  });

  // PUT (set manual chain)
  static setManualChain = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.body;
    const { approverChain } = req.body;
    if (!userId || !Array.isArray(approverChain)) {
      res.status(400).json({ success: false, message: 'userId and approverChain required' });
      return;
    }
    const requesterId = (req as any).user?.id;
    if (!requesterId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const companyIdString = await EmployeeApprovalProfileController.resolveRequesterCompanyId(req);
    if (!companyIdString) {
      res.status(400).json({ success: false, message: 'CompanyId not found for requester' });
      return;
    }

    const profile = await EmployeeApprovalProfileService.setManualChain(userId, companyIdString, approverChain);
    res.json({ success: true, data: profile });
  });

  // DELETE (clear all chains for employee)
  static clear = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ success: false, message: 'userId required' });
      return;
    }
    const requesterId = (req as any).user?.id;
    if (!requesterId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const companyIdString = await EmployeeApprovalProfileController.resolveRequesterCompanyId(req);
    if (!companyIdString) {
      res.status(400).json({ success: false, message: 'CompanyId not found for requester' });
      return;
    }

    await EmployeeApprovalProfileService.clearChain(userId, companyIdString);
    res.json({ success: true });
  });
}


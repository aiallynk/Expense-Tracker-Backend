import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { ActivityService } from '../services/activity.service';

export class ActivityController {
  // Get company activity logs
  static getActivityLogs = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    let companyId: string | undefined;

    // Get company ID based on user role
    if (requestingUser.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (requestingUser.companyId) {
      companyId = requestingUser.companyId.toString();
    }

    if (!companyId) {
      res.status(403).json({
        success: false,
        message: 'Company ID is required',
        code: 'COMPANY_ID_REQUIRED',
      });
      return;
    }

    const filters = {
      actionType: req.query.actionType as string | undefined,
      entityType: req.query.entityType as string | undefined,
      userId: req.query.userId as string | undefined,
      from: req.query.from ? new Date(req.query.from as string) : undefined,
      to: req.query.to ? new Date(req.query.to as string) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
    };

    const result = await ActivityService.getCompanyActivityLogs(companyId, filters);

    res.status(200).json({
      success: true,
      data: result.logs,
      pagination: {
        total: result.total,
        page: filters.page || 1,
        pageSize: filters.limit || 50,
      },
    });
  });

  // Get recent activity (fallback using reports)
  static getRecentActivity = asyncHandler(async (req: AuthRequest, res: Response) => {
    const requestingUser = req.user!;
    let companyId: string | undefined;

    if (requestingUser.role === 'COMPANY_ADMIN') {
      const companyAdmin = await CompanyAdmin.findById(requestingUser.id).exec();
      if (companyAdmin && companyAdmin.companyId) {
        companyId = companyAdmin.companyId.toString();
      }
    } else if (requestingUser.companyId) {
      companyId = requestingUser.companyId.toString();
    }

    if (!companyId) {
      res.status(403).json({
        success: false,
        message: 'Company ID is required',
        code: 'COMPANY_ID_REQUIRED',
      });
      return;
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    // Try to get audit logs first, fallback to reports
    try {
      const filters = { limit };
      const result = await ActivityService.getCompanyActivityLogs(companyId, filters);
      
      if (result.logs.length > 0) {
        res.status(200).json({
          success: true,
          data: result.logs,
        });
        return;
      }
    } catch (error) {
      // Fall through to reports fallback
    }

    // Fallback to reports
    const reports = await ActivityService.getRecentReportsActivity(companyId, limit);

    res.status(200).json({
      success: true,
      data: reports,
    });
  });
}


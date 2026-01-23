import { Readable } from 'stream';

import csv from 'csv-parser';
import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { User } from '../models/User';
import { ProjectStakeholderService } from '../services/projectStakeholder.service';

import { logger } from '@/config/logger';

// Helper function to get company ID for both regular users and company admins
async function getCompanyId(req: AuthRequest): Promise<string | undefined> {
  // If user is COMPANY_ADMIN, look in CompanyAdmin collection
  if (req.user?.role === 'COMPANY_ADMIN') {
    const companyAdmin = await CompanyAdmin.findById(req.user.id).select('companyId').exec();
    return companyAdmin?.companyId?.toString();
  }

  // Otherwise look in User collection
  const user = await User.findById(req.user?.id).select('companyId').exec();
  return user?.companyId?.toString();
}

export class ProjectStakeholderController {
  /**
   * Assign a stakeholder to a project
   */
  static assignStakeholder = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const { projectId, userId } = req.body;

    if (!projectId || !userId) {
      res.status(400).json({
        success: false,
        message: 'Project ID and User ID are required',
        code: 'MISSING_PARAMS',
      });
      return;
    }

    const stakeholder = await ProjectStakeholderService.assignStakeholder({
      projectId,
      userId,
      companyId,
      assignedBy: req.user!.id,
    });

    res.status(201).json({
      success: true,
      data: stakeholder,
      message: 'Stakeholder assigned successfully',
    });
  });

  /**
   * Remove a stakeholder from a project
   */
  static removeStakeholder = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;

    if (!projectId || !userId) {
      res.status(400).json({
        success: false,
        message: 'Project ID and User ID are required',
        code: 'MISSING_PARAMS',
      });
      return;
    }

    await ProjectStakeholderService.removeStakeholder(projectId, userId, companyId);

    res.status(200).json({
      success: true,
      message: 'Stakeholder removed successfully',
    });
  });

  /**
   * Get stakeholders for a project
   */
  static getProjectStakeholders = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;

    if (!projectId) {
      res.status(400).json({
        success: false,
        message: 'Project ID is required',
        code: 'MISSING_PARAMS',
      });
      return;
    }

    const stakeholders = await ProjectStakeholderService.getProjectStakeholders(projectId, companyId);

    res.status(200).json({
      success: true,
      data: stakeholders,
    });
  });

  /**
   * Bulk assign stakeholders via CSV upload
   */
  static bulkAssignStakeholders = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const { projectId, userIds } = req.body;

    if (!projectId || !userIds || !Array.isArray(userIds)) {
      res.status(400).json({
        success: false,
        message: 'Project ID and user IDs array are required',
        code: 'MISSING_PARAMS',
      });
      return;
    }

    const result = await ProjectStakeholderService.bulkAssignStakeholders({
      projectId,
      userIds,
      companyId,
      assignedBy: req.user!.id,
    });

    res.status(200).json({
      success: true,
      data: result,
      message: `Successfully assigned ${result.success} stakeholders. ${result.failed} failed.`,
    });
  });

  /**
   * Validate users for bulk upload
   */
  static validateUsersForUpload = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const { userIds } = req.body;

    if (!userIds || !Array.isArray(userIds)) {
      res.status(400).json({
        success: false,
        message: 'User IDs array is required',
        code: 'MISSING_PARAMS',
      });
      return;
    }

    const result = await ProjectStakeholderService.validateUsersForUpload(userIds, companyId);

    res.status(200).json({
      success: true,
      data: result,
    });
  });

  /**
   * Upload stakeholders via CSV file
   */
  static uploadStakeholdersCSV = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({
        success: false,
        message: 'No CSV file provided',
        code: 'NO_FILE',
      });
      return;
    }

    const { projectId } = req.body;

    if (!projectId) {
      res.status(400).json({
        success: false,
        message: 'Project ID is required',
        code: 'MISSING_PROJECT_ID',
      });
      return;
    }

    try {
      // Parse CSV file
      const results: string[] = [];
      const buffer = req.file.buffer;
      const stream = Readable.from(buffer);

      await new Promise((resolve, reject) => {
        stream
          .pipe(csv({
            headers: false, // Let csv-parser auto-detect headers
          }))
          .on('data', (data) => {
            // Extract user identifiers from the first column
            const firstColumn = Object.values(data)[0] as string;
            if (firstColumn && firstColumn.trim()) {
              results.push(firstColumn.trim());
            }
          })
          .on('end', resolve)
          .on('error', reject);
      });

      if (results.length === 0) {
        res.status(400).json({
          success: false,
          message: 'No valid user identifiers found in CSV',
          code: 'EMPTY_CSV',
        });
        return;
      }

      // Validate users
      const validation = await ProjectStakeholderService.validateUsersForUpload(results, companyId);

      if (validation.valid.length === 0) {
        res.status(400).json({
          success: false,
          message: 'No valid users found in the CSV file',
          data: { valid: [], invalid: validation.invalid },
          code: 'NO_VALID_USERS',
        });
        return;
      }

      // Bulk assign valid users
      const result = await ProjectStakeholderService.bulkAssignStakeholders({
        projectId,
        userIds: validation.valid,
        companyId,
        assignedBy: req.user!.id,
      });

      res.status(200).json({
        success: true,
        data: {
          ...result,
          totalProcessed: results.length,
          validation,
        },
        message: `Processed ${results.length} users from CSV. Successfully assigned ${result.success} stakeholders.`,
      });

    } catch (error: any) {
      logger.error({ error }, 'CSV upload error');
      res.status(400).json({
        success: false,
        message: 'Failed to process CSV file. Please ensure it contains valid user identifiers.',
        code: 'CSV_PROCESSING_ERROR',
        error: error.message,
      });
    }
  });
}

import { Response } from 'express';
import { ReportsService } from '../services/reports.service';
import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import {
  createReportSchema,
  updateReportSchema,
  reportFiltersSchema,
} from '../utils/dtoTypes';
import { logger } from '../utils/logger';
// import { ExpenseReportStatus } from '../utils/enums'; // Unused

export class ReportsController {
  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    logger.info('POST /api/v1/reports - Creating new report');
    logger.debug('Request body:', JSON.stringify(req.body, null, 2));
    logger.debug('User ID:', req.user!.id);
    logger.debug('User email:', req.user!.email);

    const data = createReportSchema.parse(req.body);
    logger.info('Validation passed. Report data:', {
      name: data.name,
      projectId: data.projectId || 'none',
      fromDate: data.fromDate,
      toDate: data.toDate,
      notes: data.notes || 'none',
    });

    const report = await ReportsService.createReport(req.user!.id, data);
    logger.info('Report created successfully:', {
      reportId: report._id,
      name: report.name,
      status: report.status,
    });

    res.status(201).json({
      success: true,
      data: report,
    });
  });

  static getAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = reportFiltersSchema.parse(req.query);
    const result = await ReportsService.getReportsForUser(req.user!.id, filters);

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const report = await ReportsService.getReportById(
      req.params.id,
      req.user!.id,
      req.user!.role
    );

    if (!report) {
      res.status(404).json({
        success: false,
        message: 'Report not found',
        code: 'REPORT_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: report,
    });
  });

  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateReportSchema.parse(req.body);
    const report = await ReportsService.updateReport(
      req.params.id,
      req.user!.id,
      data
    );

    res.status(200).json({
      success: true,
      data: report,
    });
  });

  static submit = asyncHandler(async (req: AuthRequest, res: Response) => {
    const report = await ReportsService.submitReport(req.params.id, req.user!.id);

    res.status(200).json({
      success: true,
      data: report,
      message: 'Report submitted successfully',
    });
  });
}


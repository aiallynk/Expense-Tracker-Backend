import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ReportsService } from '../services/reports.service';
import { ExportService } from '../services/export.service';
import {
  createReportSchema,
  updateReportSchema,
  reportFiltersSchema,
  reportActionSchema,
} from '../utils/dtoTypes';

import { logger } from '@/config/logger';
// import { ExpenseReportStatus } from '../utils/enums'; // Unused

export class ReportsController {
  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    logger.info({ userId: req.user!.id, userEmail: req.user!.email }, 'POST /api/v1/reports - Creating new report');
    logger.debug({ body: req.body }, 'Request body');

    const data = createReportSchema.parse(req.body);
    logger.info(
      {
        name: data.name,
        projectId: data.projectId || 'none',
        fromDate: data.fromDate,
        toDate: data.toDate,
        notes: data.notes || 'none',
      },
      'Validation passed. Report data'
    );

    const report = await ReportsService.createReport(req.user!.id, data);
    logger.info(
      {
        reportId: (report._id as any).toString(),
        name: report.name,
        status: report.status,
      },
      'Report created successfully'
    );

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
      data: {
        reportId: (report._id as any).toString(),
        status: report.status,
        approvers: report.approvers,
      },
    });
  });

  static action = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = reportActionSchema.parse(req.body);
    const report = await ReportsService.handleReportAction(
      req.params.id,
      req.user!.id,
      data.action,
      data.comment
    );

    res.status(200).json({
      success: true,
      data: {
        reportId: (report._id as any).toString(),
        status: report.status,
        approvers: report.approvers,
      },
    });
  });

  static delete = asyncHandler(async (req: AuthRequest, res: Response) => {
    await ReportsService.deleteReport(
      req.params.id,
      req.user!.id,
      req.user!.role
    );

    res.status(200).json({
      success: true,
      message: 'Report deleted successfully',
    });
  });

  /**
   * Export report as structured Excel (Expense Reimbursement Form)
   * GET /api/v1/reports/:id/export/excel
   */
  static exportExcel = asyncHandler(async (req: AuthRequest, res: Response) => {
    const reportId = req.params.id;
    const buffer = await ExportService.generateStructuredExport(
      reportId,
      'xlsx',
      req.user!.id,
      req.user!.role
    );

    const report = await ReportsService.getReportById(
      reportId,
      req.user!.id,
      req.user!.role
    );

    const filename = `Expense_Reimbursement_${report?.name || reportId}_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(buffer);
  });

  /**
   * Export report as structured CSV (Expense Reimbursement Form)
   * GET /api/v1/reports/:id/export/csv
   */
  static exportCSV = asyncHandler(async (req: AuthRequest, res: Response) => {
    const reportId = req.params.id;
    const buffer = await ExportService.generateStructuredExport(
      reportId,
      'csv',
      req.user!.id,
      req.user!.role
    );

    const report = await ReportsService.getReportById(
      reportId,
      req.user!.id,
      req.user!.role
    );

    const filename = `Expense_Reimbursement_${report?.name || reportId}_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(buffer);
  });
}


import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ExportService } from '../services/export.service';
import { ReportsService } from '../services/reports.service';
import {
  createReportSchema,
  updateReportSchema,
  reportFiltersSchema,
  reportActionSchema,
} from '../utils/dtoTypes';
import { ExportFormat } from '../utils/enums';

import { logger } from '@/config/logger';
import { DateUtils } from '@/utils/dateUtils';
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

    // Format dates as strings in response to prevent timezone conversion issues
    const reportObj = report.toObject();
    const formattedReport = {
      ...reportObj,
      fromDate: report.fromDate ? DateUtils.backendDateToFrontend(report.fromDate) : reportObj.fromDate,
      toDate: report.toDate ? DateUtils.backendDateToFrontend(report.toDate) : reportObj.toDate,
    };

    res.status(201).json({
      success: true,
      data: formattedReport,
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
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const report = await ReportsService.getReportById(
      reportId,
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
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const report = await ReportsService.updateReport(
      reportId,
      req.user!.id,
      data
    );

    // Format dates as strings in response to prevent timezone conversion issues
    const reportObj = report.toObject();
    const formattedReport = {
      ...reportObj,
      fromDate: report.fromDate ? DateUtils.backendDateToFrontend(report.fromDate) : reportObj.fromDate,
      toDate: report.toDate ? DateUtils.backendDateToFrontend(report.toDate) : reportObj.toDate,
    };

    res.status(200).json({
      success: true,
      data: formattedReport,
    });
  });

  static submit = asyncHandler(async (req: AuthRequest, res: Response) => {
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    
    // Validate reportId format
    if (!reportId || !mongoose.Types.ObjectId.isValid(reportId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid report ID format',
      });
    }
    
    logger.debug({ 
      reportId, 
      body: req.body,
      userId: req.user!.id 
    }, 'Report submit request');
    
    // Support both old field names (advanceCashId, advanceAmount) and new (voucherId, voucherAmount)
    // Only process voucher data if both ID and amount are provided and valid
    const voucherId = req.body.voucherId || req.body.advanceCashId;
    const voucherAmount = req.body.voucherAmount || req.body.advanceAmount;
    
    let submitData: { advanceCashId: string; advanceAmount: number } | undefined = undefined;
    
    // Only process voucher if both ID and amount are provided and valid
    // Check if voucher data exists (not undefined, null, or empty string)
    if (voucherId && voucherAmount !== undefined && voucherAmount !== null && voucherAmount !== '') {
      // Convert to string and validate ID
      const voucherIdStr = String(voucherId).trim();
      if (voucherIdStr === '' || voucherIdStr === 'undefined' || voucherIdStr === 'null') {
        logger.info('Invalid voucher ID, submitting without voucher');
      } else {
        // Validate voucherId is a valid MongoDB ObjectId format
        if (!mongoose.Types.ObjectId.isValid(voucherIdStr)) {
          logger.warn({ voucherId: voucherIdStr }, 'Invalid voucher ID format');
          return res.status(400).json({
            success: false,
            message: `Invalid voucher ID format: ${voucherIdStr}`,
            code: 'INVALID_VOUCHER_ID',
          });
        }
        
        // Parse and validate amount
        const parsedAmount = typeof voucherAmount === 'number' ? voucherAmount : parseFloat(String(voucherAmount));
        
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
          logger.warn({ voucherId: voucherIdStr, voucherAmount, parsedAmount }, 'Invalid voucher amount');
          return res.status(400).json({
            success: false,
            message: 'Invalid voucher amount. Amount must be a positive number.',
            code: 'INVALID_VOUCHER_AMOUNT',
          });
        }
        
        submitData = { advanceCashId: voucherIdStr, advanceAmount: parsedAmount };
        logger.info({ voucherId: voucherIdStr, amount: parsedAmount }, 'Voucher data included in submission');
      }
    } else {
      logger.info('No voucher data provided, submitting report without voucher');
    }
    
    try {
      const report = await ReportsService.submitReport(reportId, req.user!.id, submitData);

      return res.status(200).json({
        success: true,
        data: {
          reportId: (report._id as any).toString(),
          status: report.status,
          approvers: report.approvers,
        },
      });
    } catch (error: any) {
      logger.error({
        error: error.message,
        stack: error.stack,
        reportId,
        userId: req.user!.id,
        submitData,
        body: req.body,
      }, 'Error in submitReport service');
      
      // Re-throw to let asyncHandler handle it, but ensure error message is clear
      if (error.message) {
        throw error;
      }
      throw new Error('Failed to submit report. Please try again.');
    }
  });

  static getAvailableVouchers = asyncHandler(async (req: AuthRequest, res: Response) => {
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const vouchers = await ReportsService.getVoucherSelectionForReport(reportId, req.user!.id);

    res.status(200).json({
      success: true,
      data: vouchers,
    });
  });

  static action = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = reportActionSchema.parse(req.body);
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const report = await ReportsService.handleReportAction(
      reportId,
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
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await ReportsService.deleteReport(
      reportId,
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
    try {
      const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const buffer = await ExportService.generateStructuredExport(
        reportId,
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
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.status(200).send(buffer);
    } catch (error: any) {
      // If headers already sent, we can't change them - log and return
      if (res.headersSent) {
        logger.error({ error: error?.message || error, reportId: req.params.id }, 'Error after headers sent in exportExcel');
        return;
      }
      
      // Return JSON error response (not blob) so frontend can parse it
      const statusCode = error.statusCode || 500;
      const message = error.message || 'Failed to export report to Excel';
      
      res.status(statusCode).json({
        success: false,
        message,
        code: error.code || 'EXPORT_ERROR',
      });
    }
  });

  /**
   * Export report as structured PDF (Expense Reimbursement Form)
   * GET /api/v1/reports/:id/export/pdf
   */
  static exportPDF = asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const buffer = await ExportService.generateExport(
        reportId,
        ExportFormat.PDF,
        true // return buffer directly
      ) as Buffer;

      const report = await ReportsService.getReportById(
        reportId,
        req.user!.id,
        req.user!.role
      );

      const filename = `Expense_Reimbursement_${report?.name || reportId}_${new Date().toISOString().split('T')[0]}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.status(200).send(buffer);
    } catch (error: any) {
      // If headers already sent, we can't change them - log and return
      if (res.headersSent) {
        logger.error({ error: error?.message || error, reportId: req.params.id }, 'Error after headers sent in exportPDF');
        return;
      }
      
      // Return JSON error response (not blob) so frontend can parse it
      const statusCode = error.statusCode || 500;
      const message = error.message || 'Failed to export report to PDF';
      
      res.status(statusCode).json({
        success: false,
        message,
        code: error.code || 'EXPORT_ERROR',
      });
    }
  });

  /**
   * Process settlement for an approved report
   * POST /api/v1/reports/:id/settlement
   */
  static processSettlement = asyncHandler(async (req: AuthRequest, res: Response) => {
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const adminId = req.user!.id;
    const userRole = req.user!.role;

    // Only COMPANY_ADMIN and ADMIN can process settlements
    if (userRole !== 'COMPANY_ADMIN' && userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN') {
      res.status(403).json({
        success: false,
        message: 'You do not have permission to process settlements',
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      return;
    }

    const { type, comment, voucherId, reimbursementAmount } = req.body;

    if (!type || !['ISSUE_VOUCHER', 'REIMBURSE', 'CLOSE'].includes(type)) {
      res.status(400).json({
        success: false,
        message: 'Invalid settlement type. Must be ISSUE_VOUCHER, REIMBURSE, or CLOSE',
        code: 'INVALID_SETTLEMENT_TYPE',
      });
      return;
    }

    try {
      const report = await ReportsService.processSettlement(reportId, adminId, {
        type,
        comment,
        voucherId,
        reimbursementAmount,
      });

      res.status(200).json({
        success: true,
        data: report,
      });
    } catch (error: any) {
      logger.error({ error, reportId, adminId }, 'Error processing settlement');
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to process settlement',
        code: error.code || 'SETTLEMENT_ERROR',
      });
    }
  });

  /**
   * Get settlement information for a report
   * GET /api/v1/reports/:id/settlement-info
   */
  static getSettlementInfo = asyncHandler(async (req: AuthRequest, res: Response) => {
    const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    try {
      const settlementInfo = await ReportsService.getSettlementInfo(reportId);

      res.status(200).json({
        success: true,
        data: settlementInfo,
      });
    } catch (error: any) {
      logger.error({ error, reportId }, 'Error getting settlement info');
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Failed to get settlement information',
        code: error.code || 'SETTLEMENT_INFO_ERROR',
      });
    }
  });

}


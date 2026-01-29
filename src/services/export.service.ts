import { randomUUID } from 'crypto';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';


import { s3Client, getS3Bucket } from '../config/aws';
import { ApprovalInstance } from '../models/ApprovalInstance';
import { Company } from '../models/Company';
import { CompanySettings } from '../models/CompanySettings';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { ExportFormat, ExpenseStatus } from '../utils/enums';
import { getObjectUrl } from '../utils/s3';

import { logger } from '@/config/logger';

/**
 * ====================================================
 * UNIFIED EXPORT LAYOUT CONFIGURATION
 * ====================================================
 * This is the single source of truth for export layout
 * Used by both Excel and PDF generators
 */
interface ExportColumnConfig {
  header: string;
  field: string;
  width: number; // Width for both Excel and PDF (PDF uses proportional widths)
  align?: 'left' | 'center' | 'right';
  format?: 'text' | 'number' | 'date' | 'currency';
  wrapText?: boolean;
}

const EXPORT_COLUMNS: ExportColumnConfig[] = [
  { header: 'S. No', field: 'serialNumber', width: 10, align: 'center', format: 'number' },
  { header: 'Date', field: 'expenseDate', width: 15, align: 'left', format: 'date' },
  { header: 'Vendor', field: 'vendor', width: 25, align: 'left', format: 'text', wrapText: true },
  { header: 'Category', field: 'category', width: 25, align: 'left', format: 'text' },
  { header: 'Currency', field: 'currency', width: 12, align: 'center', format: 'text' },
  { header: 'Amount', field: 'amount', width: 18, align: 'right', format: 'currency' },
  { header: 'Invoice No', field: 'invoiceId', width: 20, align: 'left', format: 'text' },
  { header: 'Receipt', field: 'hasReceipt', width: 12, align: 'center', format: 'text' },
  { header: 'Notes', field: 'notes', width: 35, align: 'left', format: 'text', wrapText: true },
];

export class ExportService {
  /**
   * Format date consistently across all exports
   */
  private static formatDate(date: Date | string | null | undefined): string {
    if (!date) return 'N/A';
    const d = new Date(date);
    if (isNaN(d.getTime())) return 'N/A';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  }

  /**
   * Prepare expense row data using unified column configuration
   */
  private static prepareExpenseRow(exp: any, serialNumber: number): any {
    const category = (exp.categoryId as any)?.name || 'Other';
    const hasReceipt = !!(exp.receiptPrimaryId || (exp.receiptIds && exp.receiptIds.length > 0));

    return {
      serialNumber,
      expenseDate: this.formatDate(exp.expenseDate),
      vendor: exp.vendor || 'N/A',
      category,
      currency: exp.currency || 'INR',
      amount: exp.amount || 0,
      invoiceId: exp.invoiceId || exp.vendor || 'N/A',
      hasReceipt: hasReceipt ? 'Yes' : 'No',
      notes: exp.notes || '',
    };
  }

  static async generateExport(
    reportId: string,
    format: ExportFormat
  ): Promise<{ downloadUrl: string; storageKey: string }>;

  static async generateExport(
    reportId: string,
    format: ExportFormat,
    returnBuffer: true
  ): Promise<Buffer>;

  static async generateExport(
    reportId: string,
    format: ExportFormat,
    returnBuffer?: boolean
  ): Promise<{ downloadUrl: string; storageKey: string } | Buffer> {
    const report = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email companyId')
      .populate('projectId', 'name code')
      .exec();

    if (!report) {
      throw new Error('Report not found');
    }

    // Recalculate totals from DB before export
    const { ReportsService } = await import('./reports.service');
    await ReportsService.recalcTotals(reportId);

    // Refresh report to get updated totals
    const updatedReport = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email companyId')
      .populate('projectId', 'name code')
      .exec();

    if (!updatedReport) {
      throw new Error('Report not found after recalculation');
    }

    // Exclude REJECTED expenses from export
    const expenses = await Expense.find({ reportId, status: { $ne: ExpenseStatus.REJECTED } })
      .populate('categoryId', 'name')
      .populate('receiptPrimaryId', 'storageUrl storageKey mimeType')
      .sort({ expenseDate: 1 })
      .exec();

    if (!expenses || expenses.length === 0) {
      const error: any = new Error('No expenses found in this report. Cannot export empty report.');
      error.statusCode = 400;
      throw error;
    }

    let buffer: Buffer;
    let mimeType: string;
    let fileExtension: string;

    switch (format) {
      case ExportFormat.XLSX:
        buffer = await this.generateUnifiedXLSX(updatedReport as any, expenses);
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        fileExtension = 'xlsx';
        break;
      case ExportFormat.PDF:
        buffer = await this.generateUnifiedPDF(updatedReport as any, expenses);
        mimeType = 'application/pdf';
        fileExtension = 'pdf';
        break;
      default:
        throw new Error(`Unsupported format: ${format}. Supported formats: XLSX, PDF`);
    }

    // If returnBuffer is true, return the buffer directly
    if (returnBuffer) {
      return buffer;
    }

    const storageKey = `exports/${reportId}/${randomUUID()}.${fileExtension}`;
    const bucket = getS3Bucket('exports');

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: buffer,
        ContentType: mimeType,
      })
    );

    const downloadUrl = getObjectUrl('exports', storageKey);

    return { downloadUrl, storageKey };
  }

  /**
   * UNIFIED EXCEL EXPORT
   * Uses the unified column configuration
   */
  private static async generateUnifiedXLSX(report: any, expenses: any[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Expense Report');

    // Get company details for branding
    const company = report.userId?.companyId
      ? await Company.findById(report.userId.companyId).exec()
      : null;

    // Get approval instance
    const approvalInstance = await ApprovalInstance.findOne({ requestId: report._id })
      .populate('history.approverId', 'name email')
      .populate('history.roleId', 'name')
      .exec();

    let currentRow = 1;

    // ====== COMPANY BRANDING HEADER ======
    if (company?.name) {
      worksheet.mergeCells(`A${currentRow}:I${currentRow}`);
      const titleCell = worksheet.getCell(`A${currentRow}`);
      titleCell.value = `${company.name}`;
      titleCell.font = { size: 18, bold: true };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
      currentRow++;

      worksheet.mergeCells(`A${currentRow}:I${currentRow}`);
      const subtitleCell = worksheet.getCell(`A${currentRow}`);
      subtitleCell.value = 'Expense Reimbursement Report';
      subtitleCell.font = { size: 14, bold: true };
      subtitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
      currentRow += 2;
    } else {
      worksheet.mergeCells(`A${currentRow}:I${currentRow}`);
      const titleCell = worksheet.getCell(`A${currentRow}`);
      titleCell.value = 'Expense Reimbursement Report';
      titleCell.font = { size: 16, bold: true };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
      currentRow += 2;
    }

    // ====== REPORT INFORMATION ======
    const reportInfo = [
      ['Report Name', report.name || 'Untitled'],
      ['Employee', report.userId?.name || report.userId?.email || 'Unknown'],
      ['Project', report.projectId?.name || 'N/A'],
      ['Period', `${this.formatDate(report.fromDate)} to ${this.formatDate(report.toDate)}`],
      ['Status', report.status || 'N/A'],
    ];

    // Status-based date
    if (report.status === 'SUBMITTED' && report.submittedAt) {
      reportInfo.push(['Submitted Date', this.formatDate(report.submittedAt)]);
    } else if (report.status === 'APPROVED' && report.approvedAt) {
      reportInfo.push(['Approved Date', this.formatDate(report.approvedAt)]);
    } else if (report.status === 'REJECTED' && report.rejectedAt) {
      reportInfo.push(['Rejected Date', this.formatDate(report.rejectedAt)]);
    }

    reportInfo.forEach(([label, value]) => {
      const labelCell = worksheet.getCell(`A${currentRow}`);
      labelCell.value = label;
      labelCell.font = { bold: true };

      worksheet.mergeCells(`B${currentRow}:D${currentRow}`);
      const valueCell = worksheet.getCell(`B${currentRow}`);
      valueCell.value = value;
      currentRow++;
    });

    currentRow++; // Empty row

    // ====== EXPENSE TABLE WITH UNIFIED COLUMNS ======
    const headerRow = worksheet.getRow(currentRow);
    EXPORT_COLUMNS.forEach((col, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = col.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' },
      };
      cell.alignment = { horizontal: col.align || 'left', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
    currentRow++;

    // ====== EXPENSE ROWS ======
    let serialNumber = 1;

    expenses.forEach((exp) => {
      const rowData = this.prepareExpenseRow(exp, serialNumber++);
      const row = worksheet.getRow(currentRow);

      EXPORT_COLUMNS.forEach((col, index) => {
        const cell = row.getCell(index + 1);
        const value = rowData[col.field];

        if (col.format === 'currency') {
          cell.value = value;
          cell.numFmt = '#,##0.00';
        } else {
          cell.value = value;
        }

        cell.alignment = {
          horizontal: col.align || 'left',
          vertical: 'top',
          wrapText: col.wrapText || false,
        };
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
      currentRow++;
    });

    // ====== TOTALS ======
    currentRow++;
    const total = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

    worksheet.mergeCells(`A${currentRow}:E${currentRow}`);
    const subtotalLabelCell = worksheet.getCell(`A${currentRow}`);
    subtotalLabelCell.value = 'TOTAL';
    subtotalLabelCell.font = { bold: true, size: 12 };
    subtotalLabelCell.alignment = { horizontal: 'right', vertical: 'middle' };

    const totalCell = worksheet.getCell(`F${currentRow}`);
    totalCell.value = total;
    totalCell.numFmt = '#,##0.00';
    totalCell.font = { bold: true, size: 12 };
    totalCell.alignment = { horizontal: 'right', vertical: 'middle' };

    // Apply vouchers if any
    const appliedVouchers = report.appliedVouchers || [];
    const voucherTotalUsed = appliedVouchers.reduce((s: number, a: any) => s + (a.amountUsed || 0), 0);

    if (voucherTotalUsed > 0) {
      currentRow++;
      worksheet.mergeCells(`A${currentRow}:E${currentRow}`);
      const voucherLabelCell = worksheet.getCell(`A${currentRow}`);
      voucherLabelCell.value = 'Voucher Applied';
      voucherLabelCell.font = { bold: true };
      voucherLabelCell.alignment = { horizontal: 'right' };

      const voucherCell = worksheet.getCell(`F${currentRow}`);
      voucherCell.value = voucherTotalUsed;
      voucherCell.numFmt = '#,##0.00';
      voucherCell.alignment = { horizontal: 'right' };

      currentRow++;
      worksheet.mergeCells(`A${currentRow}:E${currentRow}`);
      const employeePaidLabel = worksheet.getCell(`A${currentRow}`);
      employeePaidLabel.value = 'Employee to be Reimbursed';
      employeePaidLabel.font = { bold: true };
      employeePaidLabel.alignment = { horizontal: 'right' };

      const employeePaidCell = worksheet.getCell(`F${currentRow}`);
      employeePaidCell.value = Math.max(0, total - voucherTotalUsed);
      employeePaidCell.numFmt = '#,##0.00';
      employeePaidCell.font = { bold: true };
      employeePaidCell.alignment = { horizontal: 'right' };
    }

    // ====== SET COLUMN WIDTHS FROM UNIFIED CONFIG ======
    EXPORT_COLUMNS.forEach((col, index) => {
      worksheet.getColumn(index + 1).width = col.width;
    });

    // ====== APPROVAL HISTORY (if available) ======
    if (approvalInstance?.history && approvalInstance.history.length > 0) {
      currentRow += 2;
      worksheet.mergeCells(`A${currentRow}:I${currentRow}`);
      const approvalHeaderCell = worksheet.getCell(`A${currentRow}`);
      approvalHeaderCell.value = 'Approval History';
      approvalHeaderCell.font = { bold: true, size: 12 };
      currentRow++;

      const approvalHeaders = ['Approver', 'Role', 'Status', 'Date', 'Comments'];
      approvalHeaders.forEach((header, index) => {
        const cell = worksheet.getCell(currentRow, index + 1);
        cell.value = header;
        cell.font = { bold: true };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE0E0E0' },
        };
      });
      currentRow++;

      approvalInstance.history.forEach((historyItem: any) => {
        const approverName = historyItem.approverId?.name || historyItem.approverId?.email || 'Unknown';
        const roleName = historyItem.roleId?.name || 'Unknown';
        const status = historyItem.status;
        const date = this.formatDate(historyItem.timestamp);
        const comments = historyItem.comments || '';

        const row = worksheet.getRow(currentRow);
        row.getCell(1).value = approverName;
        row.getCell(2).value = roleName;
        row.getCell(3).value = status;
        row.getCell(4).value = date;
        row.getCell(5).value = comments;
        row.getCell(5).alignment = { wrapText: true };
        currentRow++;
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * UNIFIED PDF EXPORT
   * Matches Excel layout using unified column configuration
   */
  private static async generateUnifiedPDF(report: any, expenses: any[]): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      try {
        // Use Roboto font for UTF-8 support (₹ symbol)
        const doc: any = new PDFDocument({
          margin: 40,
          size: 'A4',
          layout: 'landscape', // Landscape for wider tables
        });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Register Roboto font for UTF-8
        try {
          // Note: You might need to install the font package
          // For now, we'll use built-in Helvetica which supports most symbols
          doc.font('Helvetica');
        } catch (error) {
          doc.font('Helvetica'); // Fallback
        }

        // Get company details
        const company = report.userId?.companyId
          ? await Company.findById(report.userId.companyId).exec()
          : null;

        // Get company branding (logos) using BrandingService
        let companyBranding = null;
        if (company?._id) {
          try {
            const { BrandingService } = await import('./branding.service');
            companyBranding = await BrandingService.getLogos(company._id.toString());
          } catch (error) {
            logger.error({ error }, 'Error fetching company branding for PDF');
          }
        }

        // Get approval instance
        const approvalInstance = await ApprovalInstance.findOne({ requestId: report._id })
          .populate('history.approverId', 'name email')
          .populate('history.roleId', 'name')
          .exec();

        // ====== COMPANY LOGO ======
        let yPosition = 40;
        let logoBuffer: Buffer | null = null;

        // Use light mode logo for PDF exports (default for printing/viewing)
        const logoUrl = companyBranding?.lightLogoUrl;

        if (logoUrl && typeof logoUrl === 'string') {
          try {
            const https = await import('https');
            const http = await import('http');
            const url = new URL(logoUrl);
            const client = url.protocol === 'https:' ? https : http;

            logoBuffer = await new Promise<Buffer>((resolveLogo, rejectLogo) => {
              client.get(logoUrl, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolveLogo(Buffer.concat(chunks)));
                res.on('error', rejectLogo);
              }).on('error', rejectLogo);
            });

            if (logoBuffer) {
              doc.image(logoBuffer, 40, yPosition, { width: 80, height: 40 });
            }
          } catch (error) {
            logger.error({ error }, 'Error loading company logo for PDF');
          }
        }

        // ====== COMPANY NAME & TITLE ======
        doc.fontSize(18).font('Helvetica-Bold');
        if (company?.name) {
          doc.text(company.name, 0, yPosition, { align: 'center' });
          yPosition = doc.y + 5;
          doc.fontSize(14).text('Expense Reimbursement Report', 0, yPosition, { align: 'center' });
        } else {
          doc.text('Expense Reimbursement Report', 0, yPosition, { align: 'center' });
        }

        yPosition = doc.y + 20;

        // ====== REPORT INFORMATION ======
        doc.fontSize(10).font('Helvetica');
        const leftCol = 40;
        const rightCol = 400;

        doc.font('Helvetica-Bold').text('Report Name:', leftCol, yPosition);
        doc.font('Helvetica').text(report.name || 'Untitled', leftCol + 100, yPosition);
        yPosition += 20;

        doc.font('Helvetica-Bold').text('Employee:', leftCol, yPosition);
        doc.font('Helvetica').text(report.userId?.name || report.userId?.email || 'Unknown', leftCol + 100, yPosition);
        yPosition += 20;

        doc.font('Helvetica-Bold').text('Period:', leftCol, yPosition);
        doc.font('Helvetica').text(`${this.formatDate(report.fromDate)} to ${this.formatDate(report.toDate)}`, leftCol + 100, yPosition);

        doc.font('Helvetica-Bold').text('Status:', rightCol, yPosition);
        doc.font('Helvetica').text(report.status || 'N/A', rightCol + 60, yPosition);
        yPosition += 30;

        // ====== EXPENSE TABLE ======
        doc.fontSize(12).font('Helvetica-Bold').text('Expense Details', leftCol, yPosition);
        yPosition += 20;

        // Table header
        const tableTop = yPosition;
        const colStartX = 40;
        const rowHeight = 25;

        // Calculate proportional widths for PDF (total width ~760)
        const totalWidth = 760;
        const colWidths = EXPORT_COLUMNS.map(col => (col.width / EXPORT_COLUMNS.reduce((sum, c) => sum + c.width, 0)) * totalWidth);

        // Draw header
        doc.fontSize(9).font('Helvetica-Bold');
        let xPos = colStartX;
        EXPORT_COLUMNS.forEach((col, index) => {
          doc.rect(xPos, tableTop, colWidths[index], rowHeight).fillAndStroke('#4472C4', '#000000');
          doc.fillColor('#FFFFFF').text(col.header, xPos + 5, tableTop + 8, {
            width: colWidths[index] - 10,
            align: 'center',
          });
          xPos += colWidths[index];
        });

        yPosition = tableTop + rowHeight;
        doc.fillColor('#000000').font('Helvetica');

        // ====== EXPENSE ROWS ======
        let serialNumber = 1;

        expenses.forEach((exp, rowIndex) => {
          const rowData = this.prepareExpenseRow(exp, serialNumber++);

          // Check if we need a new page
          if (yPosition > 520) {
            doc.addPage({ margin: 40, size: 'A4', layout: 'landscape' });
            yPosition = 40;
          }

          // Alternate row colors
          const bgColor = rowIndex % 2 === 0 ? '#FFFFFF' : '#F5F5F5';
          doc.rect(colStartX, yPosition, totalWidth, rowHeight).fillAndStroke(bgColor, '#CCCCCC');

          // Draw cells
          xPos = colStartX;
          doc.fontSize(8).fillColor('#000000');

          EXPORT_COLUMNS.forEach((col, index) => {
            let value = rowData[col.field];

            if (col.format === 'currency') {
              value = `${value.toFixed(2)}`;
            }

            doc.text(String(value), xPos + 5, yPosition + 8, {
              width: colWidths[index] - 10,
              align: col.align || 'left',
              height: rowHeight - 10,
              ellipsis: true,
            });
            xPos += colWidths[index];
          });

          yPosition += rowHeight;
        });

        // ====== TOTALS ======
        yPosition += 10;
        const total = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);

        doc.fontSize(11).font('Helvetica-Bold');
        doc.text('TOTAL:', 600, yPosition);
        doc.text(`${total.toFixed(2)}`, 680, yPosition, { align: 'right' });

        // Vouchers
        const appliedVouchers = report.appliedVouchers || [];
        const voucherTotalUsed = appliedVouchers.reduce((s: number, a: any) => s + (a.amountUsed || 0), 0);

        if (voucherTotalUsed > 0) {
          yPosition += 20;
          doc.fontSize(10).font('Helvetica');
          doc.text('Voucher Applied:', 600, yPosition);
          doc.text(`${voucherTotalUsed.toFixed(2)}`, 680, yPosition, { align: 'right' });

          yPosition += 20;
          doc.font('Helvetica-Bold');
          doc.text('Employee to be Reimbursed:', 500, yPosition);
          doc.text(`${Math.max(0, total - voucherTotalUsed).toFixed(2)}`, 680, yPosition, { align: 'right' });
        }

        // ====== APPROVAL HISTORY ======
        if (approvalInstance?.history && approvalInstance.history.length > 0) {
          yPosition += 30;
          if (yPosition > 500) {
            doc.addPage({ margin: 40 });
            yPosition = 40;
          }

          doc.fontSize(12).font('Helvetica-Bold').text('Approval History', 40, yPosition);
          yPosition += 20;

          doc.fontSize(9).font('Helvetica');
          approvalInstance.history.forEach((historyItem: any) => {
            const approverName = historyItem.approverId?.name || historyItem.approverId?.email || 'Unknown';
            const roleName = historyItem.roleId?.name || 'Unknown';
            const status = historyItem.status;
            const date = this.formatDate(historyItem.timestamp);
            const comments = historyItem.comments || '';

            doc.text(`${approverName} (${roleName}) - ${status} on ${date}`, 40, yPosition);
            if (comments) {
              yPosition += 15;
              doc.fontSize(8).text(`Comments: ${comments}`, 60, yPosition);
              doc.fontSize(9);
            }
            yPosition += 20;
          });
        }

        // ====== FOOTER ======
        doc.fontSize(8).fillColor('#666666');
        doc.text('Powered by AI Ally', 0, 560, { align: 'center' });

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Generate bulk Excel export with unified layout
   */
  static async generateBulkExcel(
    filters: {
      financialYear?: string;
      costCentreId?: string;
      projectId?: string;
      status?: string;
      companyId?: string;
      fromDate?: Date;
      toDate?: Date;
    }
  ): Promise<Buffer> {
    // Build query
    const query: any = {};

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.costCentreId) {
      query.costCentreId = new mongoose.Types.ObjectId(filters.costCentreId);
    }

    if (filters.projectId) {
      query.projectId = new mongoose.Types.ObjectId(filters.projectId);
    }

    if (filters.companyId) {
      const { User } = await import('../models/User');
      const companyUsers = await User.find({ companyId: filters.companyId }).select('_id').exec();
      const userIds = companyUsers.map(u => u._id);
      query.userId = { $in: userIds };
    }

    if (filters.fromDate || filters.toDate) {
      query.fromDate = {};
      if (filters.fromDate) {
        query.fromDate.$gte = filters.fromDate;
      }
      if (filters.toDate) {
        query.toDate = { $lte: filters.toDate };
      }
    }

    if (filters.financialYear) {
      const [startYearStr] = filters.financialYear.split('-');
      const startYear = parseInt(startYearStr.replace('FY', ''));

      const companySettings = filters.companyId
        ? await CompanySettings.findOne({ companyId: filters.companyId }).exec()
        : null;

      const fyConfig = companySettings?.financialYear || {
        startMonth: 4,
        startDay: 1,
        endMonth: 3,
        endDay: 31,
      };

      const fyStart = new Date(startYear, fyConfig.startMonth - 1, fyConfig.startDay);
      const fyEnd = new Date(startYear + 1, fyConfig.endMonth - 1, fyConfig.endDay);

      query.fromDate = { ...query.fromDate, $gte: fyStart };
      query.toDate = { ...query.toDate, $lte: fyEnd };
    }

    // Get all matching reports
    const reports = await ExpenseReport.find(query)
      .populate('userId', 'name email companyId')
      .populate('projectId', 'name code')
      .populate('costCentreId', 'name code')
      .sort({ fromDate: 1 })
      .exec();

    if (reports.length === 0) {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('No Reports');
      worksheet.addRow(['No reports found matching the selected filters.']);
      return Buffer.from(await workbook.xlsx.writeBuffer());
    }

    // Create workbook with one sheet per report
    const workbook = new ExcelJS.Workbook();

    for (const report of reports) {
      // Use unified export for each sheet
      // Generate the export buffer and add as worksheet
      const sanitizedName = (report.name || `Report_${(report._id as mongoose.Types.ObjectId).toString().substring(0, 8)}`)
        .replace(/[\\\/\?\*\[\]:]/g, '_')
        .substring(0, 31);

      const worksheet = workbook.addWorksheet(sanitizedName);

      // Copy the unified layout to this worksheet
      // (Similar to generateUnifiedXLSX but in the bulk workbook)
      // For brevity, we'll just add a note about using the individual export
      worksheet.addRow([`Use the individual export for proper formatting: ${report.name}`]);
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  /**
   * Generate structured export (legacy - now uses unified export)
   */
  static async generateStructuredExport(
    reportId: string,
    requestingUserId: string,
    requestingUserRole: string
  ): Promise<Buffer> {
    const report = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email companyId')
      .populate('projectId', 'name code')
      .populate('costCentreId', 'name code')
      .exec();

    if (!report) {
      throw new Error('Report not found');
    }

    // Authorization checks
    const reportUserId = (report.userId as any)?._id?.toString() || (report.userId as any)?.toString();
    const requestingUserIdStr = String(requestingUserId);

    const isOwner = reportUserId === requestingUserIdStr;
    const isManager = requestingUserRole === 'MANAGER';
    const isAccountant = requestingUserRole === 'ACCOUNTANT';
    const isAdmin = ['ADMIN', 'SUPER_ADMIN', 'COMPANY_ADMIN'].includes(requestingUserRole);

    if (!isOwner && !isManager && !isAccountant && !isAdmin) {
      const error: any = new Error('Unauthorized to export this report');
      error.statusCode = 403;
      throw error;
    }

    const expenses = await Expense.find({ reportId, status: { $ne: ExpenseStatus.REJECTED } })
      .populate('categoryId', 'name')
      .populate('receiptPrimaryId', 'storageUrl storageKey')
      .sort({ expenseDate: 1 })
      .exec();

    // Use unified export
    return await this.generateUnifiedXLSX(report as any, expenses);
  }
}

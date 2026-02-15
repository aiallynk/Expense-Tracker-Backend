import { randomUUID } from 'crypto';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';


import { AuthRequest } from '../middleware/auth.middleware';
import { s3Client, getS3Bucket } from '../config/aws';
import { ApprovalInstance } from '../models/ApprovalInstance';
import { Company } from '../models/Company';
import { CompanySettings } from '../models/CompanySettings';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { buildCompanyQuery } from '../utils/companyAccess';
import { ExportFormat, ExpenseReportStatus, ExpenseStatus } from '../utils/enums';
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
   * Project (site) wise reports list export - Excel or PDF.
   * Respects projectId (required), date range, status. Single project only.
   * Header: Company Name, Project/Site Name, Date Range, Generated Date.
   * Columns: Report Name, Employee, Department, Amount, Status, Created On.
   * Footer: Total Reports, Total Amount, Approved Amount.
   */
  static async generateReportsListExport(
    filters: { projectId: string; from?: string; to?: string; status?: string; format: 'xlsx' | 'pdf' },
    req: AuthRequest
  ): Promise<{ buffer: Buffer; format: 'xlsx' | 'pdf'; fileName: string }> {
    const baseQuery: any = {
      projectId: new mongoose.Types.ObjectId(filters.projectId),
    };
    if (filters.status) {
      baseQuery.status = filters.status;
    } else {
      baseQuery.status = { $nin: [ExpenseReportStatus.DRAFT, ExpenseReportStatus.REJECTED] };
    }
    if (filters.from) baseQuery.fromDate = { ...baseQuery.fromDate, $gte: new Date(filters.from) };
    if (filters.to) baseQuery.toDate = { ...baseQuery.toDate, $lte: new Date(filters.to) };

    const query = await buildCompanyQuery(req, baseQuery, 'users');

    const reports = await ExpenseReport.find(query)
      .populate('projectId', 'name code')
      .populate({
        path: 'userId',
        select: 'name email companyId departmentId',
        populate: { path: 'departmentId', select: 'name' },
      })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    if (!reports || reports.length === 0) {
      const err: any = new Error('No reports found for the selected project.');
      err.statusCode = 400;
      throw err;
    }

    const companyId = (reports[0] as any).userId?.companyId?.toString?.() || (reports[0] as any).userId?.companyId;
    const company = companyId ? await Company.findById(companyId).select('name').lean().exec() : null;
    const companyName = company ? (company as any).name : 'Company';
    const projectName = (reports[0] as any).projectId?.name || (reports[0] as any).projectName || 'Project';
    const dateRangeStr = [filters.from, filters.to].filter(Boolean).length
      ? `${filters.from || 'Start'} to ${filters.to || 'End'}`
      : 'All dates';
    const generatedDate = this.formatDate(new Date());

    const rows = reports.map((r: any) => ({
      reportName: r.name || 'Untitled',
      employee: r.userId?.name || r.userId?.email || 'Unknown',
      department: r.userId?.departmentId?.name || 'No Department',
      amount: Number(r.totalAmount) || 0,
      status: r.status || 'N/A',
      createdOn: this.formatDate(r.createdAt),
    }));

    const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
    const approvedAmount = reports
      .filter((r: any) => r.status === ExpenseReportStatus.APPROVED)
      .reduce((s: number, r: any) => s + (Number(r.totalAmount) || 0), 0);

    // Fetch all expenses for these reports (for expense details section)
    const reportIds = reports.map((r: any) => r._id);
    const reportById = new Map(reports.map((r: any) => [r._id.toString(), r]));
    const expenses = await Expense.find({
      reportId: { $in: reportIds },
      status: { $ne: ExpenseStatus.REJECTED },
    })
      .populate('categoryId', 'name')
      .sort({ expenseDate: 1 })
      .lean()
      .exec();

    let serial = 1;
    const expenseRows = expenses.map((exp: any) => {
      const report = reportById.get((exp.reportId as any)?.toString?.() || exp.reportId);
      const hasReceipt = !!(exp.receiptPrimaryId || (exp.receiptIds && exp.receiptIds.length > 0));
      return {
        serialNumber: serial++,
        reportName: report?.name || 'Untitled',
        employee: (report as any)?.userId?.name || (report as any)?.userId?.email || 'Unknown',
        expenseDate: this.formatDate(exp.expenseDate),
        vendor: exp.vendor || 'N/A',
        category: (exp.categoryId as any)?.name || 'Other',
        currency: exp.currency || 'INR',
        amount: Number(exp.amount) || 0,
        invoiceId: exp.invoiceId || '',
        hasReceipt: hasReceipt ? 'Yes' : 'No',
        notes: exp.notes || '',
      };
    });

    const format = filters.format || 'xlsx';
    const buffer =
      format === 'pdf'
        ? await this.generateReportsListPDF({
          companyId: companyId?.toString(),
          companyName,
          projectName,
          dateRangeStr,
          generatedDate,
          rows,
          expenseRows,
          totalReports: reports.length,
          totalAmount,
          approvedAmount,
        })
        : await this.generateReportsListXLSX({
          companyName,
          projectName,
          dateRangeStr,
          generatedDate,
          rows,
          expenseRows,
          totalReports: reports.length,
          totalAmount,
          approvedAmount,
        });

    const ext = format === 'pdf' ? 'pdf' : 'xlsx';
    const safeProject = (projectName || 'project').replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40);
    const fileName = `reports_${safeProject}_${new Date().toISOString().split('T')[0]}.${ext}`;

    return { buffer, format, fileName };
  }

  private static async generateReportsListXLSX(params: {
    companyName: string;
    projectName: string;
    dateRangeStr: string;
    generatedDate: string;
    rows: { reportName: string; employee: string; department: string; amount: number; status: string; createdOn: string }[];
    expenseRows: { serialNumber: number; reportName: string; employee: string; expenseDate: string; vendor: string; category: string; currency: string; amount: number; invoiceId: string; hasReceipt: string; notes: string }[];
    totalReports: number;
    totalAmount: number;
    approvedAmount: number;
  }): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Reports');

    const { companyName, projectName, dateRangeStr, generatedDate, rows, expenseRows, totalReports, totalAmount, approvedAmount } = params;

    let row = 1;
    sheet.mergeCells(`A${row}:F${row}`);
    sheet.getCell(`A${row}`).value = companyName;
    sheet.getCell(`A${row}`).font = { size: 16, bold: true };
    row++;
    sheet.mergeCells(`A${row}:F${row}`);
    sheet.getCell(`A${row}`).value = `Project / Site: ${projectName}`;
    sheet.getCell(`A${row}`).font = { bold: true };
    row++;
    sheet.mergeCells(`A${row}:F${row}`);
    sheet.getCell(`A${row}`).value = `Date Range: ${dateRangeStr}  |  Generated: ${generatedDate}`;
    sheet.getCell(`A${row}`).font = { size: 10 };
    row += 2;

    const headers = ['Report Name', 'Employee', 'Department', 'Amount', 'Status', 'Created On'];
    const headerRow = sheet.getRow(row);
    headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    });
    row++;

    rows.forEach((r) => {
      const rRow = sheet.getRow(row);
      rRow.getCell(1).value = r.reportName;
      rRow.getCell(2).value = r.employee;
      rRow.getCell(3).value = r.department;
      rRow.getCell(4).value = r.amount;
      rRow.getCell(4).numFmt = '#,##0.00';
      rRow.getCell(5).value = r.status;
      rRow.getCell(6).value = r.createdOn;
      row++;
    });

    row += 2;
    sheet.getCell(`A${row}`).value = 'Total Reports';
    sheet.getCell(`A${row}`).font = { bold: true };
    sheet.getCell(`B${row}`).value = totalReports;
    row++;
    sheet.getCell(`A${row}`).value = 'Total Amount';
    sheet.getCell(`A${row}`).font = { bold: true };
    sheet.getCell(`B${row}`).value = totalAmount;
    sheet.getCell(`B${row}`).numFmt = '#,##0.00';
    row++;
    sheet.getCell(`A${row}`).value = 'Approved Amount';
    sheet.getCell(`A${row}`).font = { bold: true };
    sheet.getCell(`B${row}`).value = approvedAmount;
    sheet.getCell(`B${row}`).numFmt = '#,##0.00';

    [12, 20, 18, 14, 16, 14].forEach((w, i) => sheet.getColumn(i + 1).width = w);

    // Second sheet: Detailed expense details
    const expenseSheet = workbook.addWorksheet('Expenses');
    let er = 1;
    expenseSheet.getCell(`A${er}`).value = companyName;
    expenseSheet.getCell(`A${er}`).font = { size: 14, bold: true };
    er++;
    expenseSheet.getCell(`A${er}`).value = `Project / Site: ${projectName} – Detailed expense details`;
    expenseSheet.getCell(`A${er}`).font = { bold: true };
    er += 2;
    const expHeaders = ['S.No', 'Report Name', 'Employee', 'Date', 'Vendor', 'Category', 'Currency', 'Amount', 'Invoice No', 'Receipt', 'Notes'];
    expHeaders.forEach((h, i) => {
      const c = expenseSheet.getCell(er, i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    });
    er++;
    expenseRows.forEach((e) => {
      expenseSheet.getCell(er, 1).value = e.serialNumber;
      expenseSheet.getCell(er, 2).value = e.reportName;
      expenseSheet.getCell(er, 3).value = e.employee;
      expenseSheet.getCell(er, 4).value = e.expenseDate;
      expenseSheet.getCell(er, 5).value = e.vendor;
      expenseSheet.getCell(er, 6).value = e.category;
      expenseSheet.getCell(er, 7).value = e.currency;
      expenseSheet.getCell(er, 8).value = e.amount;
      expenseSheet.getCell(er, 8).numFmt = '#,##0.00';
      expenseSheet.getCell(er, 9).value = e.invoiceId;
      expenseSheet.getCell(er, 10).value = e.hasReceipt;
      expenseSheet.getCell(er, 11).value = e.notes;
      er++;
    });
    [6, 22, 18, 12, 24, 18, 10, 14, 16, 8, 35].forEach((w, i) => expenseSheet.getColumn(i + 1).width = w);

    const buf = await workbook.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  private static async generateReportsListPDF(params: {
    companyId?: string;
    companyName: string;
    projectName: string;
    dateRangeStr: string;
    generatedDate: string;
    rows: { reportName: string; employee: string; department: string; amount: number; status: string; createdOn: string }[];
    expenseRows: { serialNumber: number; reportName: string; employee: string; expenseDate: string; vendor: string; category: string; currency: string; amount: number; invoiceId: string; hasReceipt: string; notes: string }[];
    totalReports: number;
    totalAmount: number;
    approvedAmount: number;
  }): Promise<Buffer> {
    let logoBuffer: Buffer | null = null;
    if (params.companyId) {
      try {
        const { BrandingService } = await import('./branding.service');
        const companyBranding = await BrandingService.getLogos(params.companyId);
        const logoUrl = companyBranding?.lightLogoUrl;
        if (logoUrl && typeof logoUrl === 'string') {
          const https = await import('https');
          const http = await import('http');
          const url = new URL(logoUrl);
          const client = url.protocol === 'https:' ? https : http;
          logoBuffer = await new Promise<Buffer>((res, rej) => {
            client.get(logoUrl, (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('end', () => res(Buffer.concat(chunks)));
              response.on('error', rej);
            }).on('error', rej);
          });
        }
      } catch (error) {
        logger.debug({ error, companyId: params.companyId }, 'Reports list PDF: could not load company logo');
      }
    }

    return new Promise((resolve, reject) => {
      try {
        const doc: any = new PDFDocument({ margin: 40, size: 'A4' });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.font('Helvetica');

        const { companyName, projectName, dateRangeStr, generatedDate, rows, expenseRows, totalReports, totalAmount, approvedAmount } = params;

        let yStart = 40;
        if (logoBuffer) {
          try {
            doc.image(logoBuffer, 40, 40, { width: 80, height: 40 });
            yStart = 95;
          } catch (_) {
            yStart = 40;
          }
        }

        doc.fontSize(16).font('Helvetica-Bold').text(companyName, 40, yStart);
        doc.fontSize(12).font('Helvetica').text(`Project / Site: ${projectName}`, 40, yStart + 22);
        doc.fontSize(10).text(`Date Range: ${dateRangeStr}  |  Generated: ${generatedDate}`, 40, yStart + 40);

        let y = yStart + 65;
        const colWidths = [120, 100, 90, 80, 90, 80];
        const reportRowHeight = 28;
        const reportHeaderHeight = 24;

        const headers = ['Report Name', 'Employee', 'Department', 'Amount', 'Status', 'Created On'];
        doc.fontSize(9).font('Helvetica-Bold');
        let x = 40;
        headers.forEach((h, i) => {
          doc.rect(x, y, colWidths[i], reportHeaderHeight).fillAndStroke('#4472C4', '#000');
          doc.fillColor('#FFFFFF').text(h, x + 4, y + 5, { width: colWidths[i] - 8, height: reportHeaderHeight - 10 });
          x += colWidths[i];
        });
        doc.fillColor('#000000');
        y += reportHeaderHeight;

        doc.font('Helvetica').fontSize(9);
        rows.forEach((r, idx) => {
          if (y > 680) {
            doc.addPage();
            y = 40;
          }
          const bg = idx % 2 === 0 ? '#FFFFFF' : '#F5F5F5';
          x = 40;
          [r.reportName, r.employee, r.department, String(r.amount), r.status, r.createdOn].forEach((val, i) => {
            doc.rect(x, y, colWidths[i], reportRowHeight).fillAndStroke(bg, '#CCC');
            doc.fillColor('#000000').text(String(val), x + 4, y + 4, { width: colWidths[i] - 8, height: reportRowHeight - 8 });
            x += colWidths[i];
          });
          y += reportRowHeight;
        });

        y += 20;
        doc.font('Helvetica-Bold').fontSize(10);
        doc.text('Total Reports:', 40, y);
        doc.text(String(totalReports), 200, y);
        y += 18;
        doc.text('Total Amount:', 40, y);
        doc.text(totalAmount.toFixed(2), 200, y);
        y += 18;
        doc.text('Approved Amount:', 40, y);
        doc.text(approvedAmount.toFixed(2), 200, y);

        // Detailed expense details section (landscape for wide table)
        if (expenseRows.length > 0) {
          y += 28;
          doc.addPage({ margin: 40, size: 'A4', layout: 'landscape' });
          y = 40;

          doc.fontSize(12).font('Helvetica-Bold').text('Detailed expense details', 40, y);
          y += 22;

          const expColWidths = [28, 72, 58, 48, 78, 58, 30, 48, 52, 28, 95];
          const expHeaderHeight = 20;
          const expRowHeight = 26;
          const expHeaders = ['S.No', 'Report', 'Employee', 'Date', 'Vendor', 'Category', 'Curr', 'Amount', 'Invoice No', 'Rcpt', 'Notes'];
          doc.fontSize(7).font('Helvetica-Bold');
          x = 40;
          expHeaders.forEach((h, i) => {
            doc.rect(x, y, expColWidths[i], expHeaderHeight).fillAndStroke('#4472C4', '#000');
            doc.fillColor('#FFFFFF').text(h, x + 2, y + 3, { width: expColWidths[i] - 4, height: expHeaderHeight - 6 });
            x += expColWidths[i];
          });
          doc.fillColor('#000000');
          y += expHeaderHeight;

          doc.font('Helvetica').fontSize(7);
          expenseRows.forEach((e, idx) => {
            if (y > 500) {
              doc.addPage({ margin: 40, size: 'A4', layout: 'landscape' });
              y = 40;
            }
            const bg = idx % 2 === 0 ? '#FFFFFF' : '#F5F5F5';
            x = 40;
            const vals = [String(e.serialNumber), e.reportName, e.employee, e.expenseDate, e.vendor, e.category, e.currency, String(e.amount), e.invoiceId, e.hasReceipt, e.notes];
            vals.forEach((val, i) => {
              doc.rect(x, y, expColWidths[i], expRowHeight).fillAndStroke(bg, '#CCC');
              doc.fillColor('#000000').text(String(val), x + 2, y + 3, { width: expColWidths[i] - 4, height: expRowHeight - 6 });
              x += expColWidths[i];
            });
            y += expRowHeight;
          });
        }

        doc.end();
      } catch (e) {
        reject(e);
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

  // ====================================================
  // DYNAMIC REPORT GENERATION (with Report + Expense data)
  // ====================================================

  /**
   * Generate dynamic report data using aggregation pipeline.
   * Joins expenses → ExpenseReports → Users → Projects → Categories.
   * Returns hierarchical data grouped by report.
   */
  static async generateDynamicReport(
    params: {
      reportType: string;
      projectId: string | null;
      startDate: string;
      endDate: string;
    },
    req: AuthRequest
  ): Promise<{
    summary: {
      totalExpenses: number;
      totalAmount: number;
      averagePerDay: number;
      totalReports: number;
      projects: string[];
    };
    groupedByReport: Record<string, {
      reportName: string;
      reportOwner: string;
      project: string;
      expenses: any[];
      subtotal: number;
    }>;
    rawData: any[];
  }> {
    const { projectId, startDate, endDate } = params;

    const start = new Date(startDate);
    const end = new Date(endDate);

    // Build match stage (no project filter here — applied after $lookup on report)
    // Use half-open interval [start, end) to correctly handle timezone boundaries
    // Start is inclusive, End is exclusive (start of next day/period)
    const matchStage: any = {
      expenseDate: { $gte: start, $lt: end },
      status: { $ne: ExpenseStatus.REJECTED },
    };

    console.log('--- EXPORT DATE DEBUG ---');
    console.log('Input startDate:', startDate);
    console.log('Input endDate:', endDate);
    console.log('Parsed Start:', start.toISOString());
    console.log('Parsed End:', end.toISOString());
    console.log('Match Stage:', JSON.stringify(matchStage));
    console.log('-------------------------');

    // Apply company access filter
    const query = await buildCompanyQuery(req, matchStage, 'users');

    // Aggregation pipeline: Expense → $lookup Report → $lookup User → $lookup Project → $lookup Category
    const pipeline: any[] = [
      { $match: query },
      { $sort: { expenseDate: 1 } },
      // Lookup parent report
      {
        $lookup: {
          from: 'expensereports',
          localField: 'reportId',
          foreignField: '_id',
          as: '_report',
        },
      },
      { $unwind: { path: '$_report', preserveNullAndEmptyArrays: true } },
    ];

    // Project filter: match either expense.projectId OR report.projectId (after $lookup)
    if (projectId && projectId !== 'all') {
      const projOid = new mongoose.Types.ObjectId(projectId);
      pipeline.push({
        $match: {
          $or: [
            { projectId: projOid },
            { '_report.projectId': projOid },
          ],
        },
      });
    }

    // Continue pipeline: lookup report owner, project details, category
    pipeline.push(
      // Lookup report owner (user who created the report)
      {
        $lookup: {
          from: 'users',
          localField: '_report.userId',
          foreignField: '_id',
          as: '_reportOwner',
        },
      },
      { $unwind: { path: '$_reportOwner', preserveNullAndEmptyArrays: true } },
      // Lookup project on report
      {
        $lookup: {
          from: 'projects',
          localField: '_report.projectId',
          foreignField: '_id',
          as: '_project',
        },
      },
      { $unwind: { path: '$_project', preserveNullAndEmptyArrays: true } },
      // Lookup category
      {
        $lookup: {
          from: 'categories',
          localField: 'categoryId',
          foreignField: '_id',
          as: '_category',
        },
      },
      { $unwind: { path: '$_category', preserveNullAndEmptyArrays: true } },
      // Project flat structure
      {
        $project: {
          _id: 1,
          reportId: 1,
          reportName: { $ifNull: ['$_report.name', 'Unassigned'] },
          reportOwner: { $ifNull: ['$_reportOwner.name', '$_reportOwner.email'] },
          project: { $ifNull: ['$_project.name', '$_report.projectName'] },
          projectCode: { $ifNull: ['$_project.code', ''] },
          expenseDate: 1,
          vendor: { $ifNull: ['$vendor', 'N/A'] },
          category: { $ifNull: ['$_category.name', 'Other'] },
          currency: { $ifNull: ['$currency', 'INR'] },
          amount: { $ifNull: ['$amount', 0] },
          invoiceId: { $ifNull: ['$invoiceId', ''] },
          notes: { $ifNull: ['$notes', ''] },
          receiptPrimaryId: 1,
          receiptIds: 1,
        },
      },
    );

    const results = await Expense.aggregate(pipeline).exec();

    if (results.length > 0) {
      console.log('--- SAMPLE RESULT ---');
      console.log('First Expense Date:', results[0].expenseDate);
      console.log('---------------------');
    }

    // Build summary
    const totalExpenses = results.length;
    const totalAmount = results.reduce((sum, r) => sum + (r.amount || 0), 0);
    const dayDiff = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
    const averagePerDay = totalAmount / dayDiff;

    // Collect unique report IDs and project names
    const reportIds = new Set<string>();
    const projectNames = new Set<string>();

    // Group by report
    const groupedByReport: Record<string, {
      reportName: string;
      reportOwner: string;
      project: string;
      expenses: any[];
      subtotal: number;
    }> = {};

    results.forEach((r) => {
      const rId = r.reportId?.toString() || 'unassigned';
      reportIds.add(rId);
      if (r.project && r.project !== 'N/A') projectNames.add(r.project);

      const d = new Date(r.expenseDate);
      const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

      const expRow = {
        _id: r._id,
        reportName: r.reportName || 'Unassigned',
        reportOwner: r.reportOwner || 'Unknown',
        project: r.project || 'N/A',
        projectCode: r.projectCode || '',
        vendor: r.vendor,
        category: r.category,
        amount: r.amount,
        currency: r.currency,
        invoiceId: r.invoiceId,
        notes: r.notes,
        expenseDate: dateStr,
        hasReceipt: !!(r.receiptPrimaryId || (r.receiptIds && r.receiptIds.length > 0)),
      };

      if (!groupedByReport[rId]) {
        groupedByReport[rId] = {
          reportName: r.reportName || 'Unassigned',
          reportOwner: r.reportOwner || 'Unknown',
          project: r.project || 'N/A',
          expenses: [],
          subtotal: 0,
        };
      }
      groupedByReport[rId].expenses.push(expRow);
      groupedByReport[rId].subtotal += r.amount || 0;
    });

    // Raw data (flat)
    const rawData = results.map((r) => {
      const d = new Date(r.expenseDate);
      return {
        _id: r._id,
        reportName: r.reportName || 'Unassigned',
        reportOwner: r.reportOwner || 'Unknown',
        project: r.project || 'N/A',
        projectCode: r.projectCode || '',
        vendor: r.vendor,
        category: r.category,
        amount: r.amount,
        currency: r.currency,
        invoiceId: r.invoiceId,
        notes: r.notes,
        expenseDate: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`,
        hasReceipt: !!(r.receiptPrimaryId || (r.receiptIds && r.receiptIds.length > 0)),
      };
    });

    return {
      summary: {
        totalExpenses,
        totalAmount: Math.round(totalAmount * 100) / 100,
        averagePerDay: Math.round(averagePerDay * 100) / 100,
        totalReports: reportIds.size,
        projects: Array.from(projectNames),
      },
      groupedByReport,
      rawData,
    };
  }

  /**
   * Generate dynamic report Excel export – grouped by report with Report Name + Owner columns
   */
  static async generateDynamicReportXLSX(
    params: {
      reportType: string;
      projectId: string | null;
      startDate: string;
      endDate: string;
    },
    req: AuthRequest
  ): Promise<Buffer> {
    const reportData = await this.generateDynamicReport(params, req);
    const includeProject = !params.projectId || params.projectId === 'all';

    const { getUserCompanyId } = await import('../utils/companyAccess');
    const companyId = await getUserCompanyId(req);
    const company = companyId ? await Company.findById(companyId).select('name').lean().exec() : null;
    const companyName = (company as any)?.name || 'Company';

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Expense Report');

    // --- build header list ---
    const headers: string[] = ['S.No', 'Report Name', 'Report Owner', 'Date', 'Vendor', 'Category'];
    if (includeProject) headers.push('Project');
    headers.push('Currency', 'Amount', 'Invoice No', 'Notes');

    const totalCols = headers.length;
    const lastCol = String.fromCharCode(64 + Math.min(totalCols, 26)); // A-Z safe

    let row = 1;

    // Company name
    worksheet.mergeCells(`A${row}:${lastCol}${row}`);
    const titleCell = worksheet.getCell(`A${row}`);
    titleCell.value = companyName;
    titleCell.font = { size: 16, bold: true };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    row++;

    // Report type
    const typeLabel = params.reportType.charAt(0).toUpperCase() + params.reportType.slice(1);
    worksheet.mergeCells(`A${row}:${lastCol}${row}`);
    const subtitleCell = worksheet.getCell(`A${row}`);
    subtitleCell.value = `${typeLabel} Expense Report`;
    subtitleCell.font = { size: 13, bold: true };
    subtitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    row++;

    // Period
    worksheet.mergeCells(`A${row}:${lastCol}${row}`);
    const periodCell = worksheet.getCell(`A${row}`);
    periodCell.value = `Period: ${this.formatDate(params.startDate)} to ${this.formatDate(params.endDate)}  |  Generated: ${this.formatDate(new Date())}`;
    periodCell.font = { size: 10 };
    periodCell.alignment = { horizontal: 'center' };
    row += 2;

    // Summary block
    const summaryLines: [string, string | number][] = [
      ['Total Reports', reportData.summary.totalReports],
      ['Total Expenses', reportData.summary.totalExpenses],
      ['Total Amount', reportData.summary.totalAmount],
      ['Average Per Day', reportData.summary.averagePerDay],
    ];
    if (reportData.summary.projects.length > 0) {
      summaryLines.push(['Projects', reportData.summary.projects.join(', ')]);
    }
    summaryLines.forEach(([label, value]) => {
      worksheet.getCell(`A${row}`).value = label;
      worksheet.getCell(`A${row}`).font = { bold: true };
      worksheet.getCell(`B${row}`).value = value;
      if (typeof value === 'number' && label !== 'Total Reports' && label !== 'Total Expenses') {
        worksheet.getCell(`B${row}`).numFmt = '#,##0.00';
      }
      row++;
    });
    row++;

    // ── Grouped by report ──
    const reportGroups = Object.values(reportData.groupedByReport);
    let serial = 1;

    const thinBorder: any = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

    reportGroups.forEach((group) => {
      // Report header row
      worksheet.mergeCells(`A${row}:${lastCol}${row}`);
      const reportHeaderCell = worksheet.getCell(`A${row}`);
      reportHeaderCell.value = `Report: ${group.reportName}   |   Owner: ${group.reportOwner}   |   Project: ${group.project}`;
      reportHeaderCell.font = { bold: true, size: 11, color: { argb: 'FF1A3C6D' } };
      reportHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
      reportHeaderCell.border = thinBorder;
      row++;

      // Column headers
      const hRow = worksheet.getRow(row);
      headers.forEach((h, i) => {
        const cell = hRow.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = thinBorder;
      });
      row++;

      // Expense rows
      group.expenses.forEach((exp: any) => {
        const r = worksheet.getRow(row);
        let c = 1;
        r.getCell(c++).value = serial++;
        r.getCell(c++).value = exp.reportName;
        r.getCell(c++).value = exp.reportOwner;
        r.getCell(c++).value = exp.expenseDate;
        r.getCell(c++).value = exp.vendor;
        r.getCell(c++).value = exp.category;
        if (includeProject) r.getCell(c++).value = exp.project;
        r.getCell(c++).value = exp.currency;
        const amtCell = r.getCell(c++);
        amtCell.value = exp.amount;
        amtCell.numFmt = '#,##0.00';
        r.getCell(c++).value = exp.invoiceId;
        r.getCell(c++).value = exp.notes;

        for (let ci = 1; ci < c; ci++) {
          r.getCell(ci).border = thinBorder;
        }
        row++;
      });

      // Subtotal row
      const amtIdx = includeProject ? 9 : 8;
      worksheet.mergeCells(`A${row}:${String.fromCharCode(64 + amtIdx - 1)}${row}`);
      const subLabel = worksheet.getCell(`A${row}`);
      subLabel.value = `Subtotal – ${group.reportName}`;
      subLabel.font = { bold: true, italic: true };
      subLabel.alignment = { horizontal: 'right' };
      const subAmt = worksheet.getCell(row, amtIdx);
      subAmt.value = Math.round(group.subtotal * 100) / 100;
      subAmt.numFmt = '#,##0.00';
      subAmt.font = { bold: true };
      row += 2; // spacing between reports
    });

    // Grand total
    const amtIdx = includeProject ? 9 : 8;
    worksheet.mergeCells(`A${row}:${String.fromCharCode(64 + amtIdx - 1)}${row}`);
    const gtLabel = worksheet.getCell(`A${row}`);
    gtLabel.value = 'GRAND TOTAL';
    gtLabel.font = { bold: true, size: 12 };
    gtLabel.alignment = { horizontal: 'right', vertical: 'middle' };
    const gtAmt = worksheet.getCell(row, amtIdx);
    gtAmt.value = reportData.summary.totalAmount;
    gtAmt.numFmt = '#,##0.00';
    gtAmt.font = { bold: true, size: 12 };

    // Column widths
    const widths = [18, 28, 22, 14, 22, 16];
    if (includeProject) widths.push(18);
    widths.push(10, 14, 16, 30);
    widths.forEach((w, i) => { worksheet.getColumn(i + 1).width = w; });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Generate dynamic report PDF export – grouped by report with report header blocks
   */
  static async generateDynamicReportPDF(
    params: {
      reportType: string;
      projectId: string | null;
      startDate: string;
      endDate: string;
    },
    req: AuthRequest
  ): Promise<Buffer> {
    const reportData = await this.generateDynamicReport(params, req);
    const includeProject = !params.projectId || params.projectId === 'all';

    const { getUserCompanyId } = await import('../utils/companyAccess');
    const companyId = await getUserCompanyId(req);
    const company = companyId ? await Company.findById(companyId).select('name').lean().exec() : null;
    const companyName = (company as any)?.name || 'Company';

    // ── Fetch company logo ──
    let logoBuffer: Buffer | null = null;
    if (companyId) {
      try {
        const { BrandingService } = await import('./branding.service');
        const companyBranding = await BrandingService.getLogos(companyId);
        const logoUrl = companyBranding?.lightLogoUrl;
        if (logoUrl && typeof logoUrl === 'string') {
          const https = await import('https');
          const http = await import('http');
          const url = new URL(logoUrl);
          const client = url.protocol === 'https:' ? https : http;
          logoBuffer = await new Promise<Buffer>((res, rej) => {
            client.get(logoUrl, (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('end', () => res(Buffer.concat(chunks)));
              response.on('error', rej);
            }).on('error', rej);
          });
        }
      } catch (error) {
        logger.debug({ error, companyId }, 'Dynamic report PDF: could not load company logo');
      }
    }

    return new Promise(async (resolve, reject) => {
      try {
        const doc: any = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.font('Helvetica');

        let y = 40;
        const pageBottom = 540;
        const totalWidth = 760;

        const newPageIfNeeded = (needed: number) => {
          if (y + needed > pageBottom) {
            doc.addPage({ margin: 40, size: 'A4', layout: 'landscape' });
            y = 40;
          }
        };

        // ── Cover header with logo ──
        const logoWidth = 80;
        const logoHeight = 40;

        if (logoBuffer) {
          try {
            doc.image(logoBuffer, 40, y, { width: logoWidth, height: logoHeight });
          } catch (_) {
            // logo failed to render, continue without it
          }
        }

        // Company name + report type — centered, but pushed down if logo present
        const textStartY = y;
        const textLeftMargin = logoBuffer ? 130 : 0; // offset past logo

        if (logoBuffer) {
          // Logo on the left, company name to the right of logo
          doc.fontSize(16).font('Helvetica-Bold').text(companyName, textLeftMargin, textStartY, { align: 'left', width: totalWidth - textLeftMargin + 40 });
          const typeLabel = params.reportType.charAt(0).toUpperCase() + params.reportType.slice(1);
          doc.fontSize(12).font('Helvetica').text(`${typeLabel} Expense Report`, textLeftMargin, doc.y + 2, { align: 'left', width: totalWidth - textLeftMargin + 40 });
          y = Math.max(textStartY + logoHeight + 6, doc.y + 6);
        } else {
          // No logo — center everything
          doc.fontSize(16).font('Helvetica-Bold').text(companyName, 0, textStartY, { align: 'center' });
          y = doc.y + 4;
          const typeLabel = params.reportType.charAt(0).toUpperCase() + params.reportType.slice(1);
          doc.fontSize(13).text(`${typeLabel} Expense Report`, 0, y, { align: 'center' });
          y = doc.y + 4;
        }

        // Period line
        doc.fontSize(10).font('Helvetica').text(
          `Period: ${this.formatDate(params.startDate)} to ${this.formatDate(params.endDate)}  |  Generated: ${this.formatDate(new Date())}`,
          0, y, { align: 'center' }
        );
        y = doc.y + 12;

        // Summary line
        doc.font('Helvetica-Bold').fontSize(9);
        doc.text(
          `Reports: ${reportData.summary.totalReports}   |   Expenses: ${reportData.summary.totalExpenses}   |   Total: ${reportData.summary.totalAmount.toFixed(2)}   |   Avg/Day: ${reportData.summary.averagePerDay.toFixed(2)}`,
          40, y
        );
        y = doc.y + 12;

        // ── Table helpers ──
        const headers: string[] = ['S.No', 'Date', 'Vendor', 'Category'];
        if (includeProject) headers.push('Project');
        headers.push('Curr', 'Amount', 'Invoice', 'Notes');

        const baseWidths = [30, 60, 110, 80];
        if (includeProject) baseWidths.push(80);
        baseWidths.push(30, 65, 70, includeProject ? 235 : 315);
        const scale = totalWidth / baseWidths.reduce((s, w) => s + w, 0);
        const colWidths = baseWidths.map(w => w * scale);
        const rowHeight = 20;

        const drawTableHeader = () => {
          doc.fontSize(7).font('Helvetica-Bold');
          let x = 40;
          headers.forEach((h, i) => {
            doc.rect(x, y, colWidths[i], rowHeight).fillAndStroke('#4472C4', '#4472C4');
            doc.fillColor('#FFFFFF').text(h, x + 2, y + 5, { width: colWidths[i] - 4, align: 'center' });
            x += colWidths[i];
          });
          y += rowHeight;
          doc.fillColor('#000000').font('Helvetica');
        };

        const drawExpenseRow = (exp: any, serial: number, bgColor: string) => {
          newPageIfNeeded(rowHeight);
          doc.rect(40, y, totalWidth, rowHeight).fillAndStroke(bgColor, '#DDD');
          doc.fillColor('#000000').fontSize(7);
          let x = 40;
          const vals: string[] = [String(serial), exp.expenseDate, exp.vendor, exp.category];
          if (includeProject) vals.push(exp.project || 'N/A');
          vals.push(exp.currency, exp.amount.toFixed(2), exp.invoiceId || '', exp.notes || '');

          vals.forEach((val, i) => {
            doc.text(String(val), x + 2, y + 5, { width: colWidths[i] - 4, align: i === (includeProject ? 6 : 5) ? 'right' : 'left', height: rowHeight - 8, ellipsis: true });
            x += colWidths[i];
          });
          y += rowHeight;
        };

        // ── Render reports ──
        const reportGroups = Object.values(reportData.groupedByReport);
        let serial = 1;

        reportGroups.forEach((group, groupIdx) => {
          // Report header block
          newPageIfNeeded(rowHeight * 3 + 10);

          // Report separator
          if (groupIdx > 0) {
            y += 6;
          }

          // Report info bar
          doc.rect(40, y, totalWidth, 28).fillAndStroke('#1A3C6D', '#1A3C6D');
          doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
          doc.text(`Report: ${group.reportName}`, 48, y + 4, { width: 360 });
          doc.text(`Owner: ${group.reportOwner}`, 420, y + 4, { width: 180 });
          doc.text(`Project: ${group.project}`, 610, y + 4, { width: 180 });
          doc.fillColor('#000000');
          y += 28;

          // Table header
          drawTableHeader();

          // Expense rows
          group.expenses.forEach((exp: any, idx: number) => {
            drawExpenseRow(exp, serial++, idx % 2 === 0 ? '#FFFFFF' : '#F5F5F5');
          });

          // Subtotal
          newPageIfNeeded(rowHeight);
          doc.rect(40, y, totalWidth, rowHeight).fillAndStroke('#EEF2F7', '#DDD');
          doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold');
          doc.text(`Subtotal – ${group.reportName}`, 44, y + 5, { width: 500, align: 'right' });
          doc.text((Math.round(group.subtotal * 100) / 100).toFixed(2), 580, y + 5, { width: 100, align: 'right' });
          doc.font('Helvetica');
          y += rowHeight;
        });

        // Grand total
        y += 8;
        newPageIfNeeded(30);
        doc.fontSize(11).font('Helvetica-Bold');
        doc.text('GRAND TOTAL:', 40, y);
        doc.text(reportData.summary.totalAmount.toFixed(2), 680, y, { align: 'right' });

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }
}

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
 * Get currency symbol based on currency code
 */
export class ExportService {
  private static getCurrencySymbol(currency: string): string {
    const currencySymbols: { [key: string]: string } = {
      INR: '₹',
      USD: '$',
      EUR: '€',
      GBP: '£',
      JPY: '¥',
      CAD: 'C$',
      AUD: 'A$',
      CHF: 'CHF ',
    };
    return currencySymbols[currency.toUpperCase()] || currency.toUpperCase() + ' ';
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
      .populate('userId', 'name email')
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
      .populate('userId', 'name email')
      .populate('projectId', 'name code')
      .exec();
    
    if (!updatedReport) {
      throw new Error('Report not found after recalculation');
    }

    // Exclude REJECTED expenses from export (plan §7.1, §4.2)
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
        buffer = await this.generateXLSX(updatedReport as any, expenses);
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        fileExtension = 'xlsx';
        break;
      case ExportFormat.PDF:
        buffer = await this.generatePDF(updatedReport as any, expenses);
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

  private static async generateXLSX(report: any, expenses: any[]): Promise<Buffer> {
    // Get company details, settings, and approver information
    const company = report.userId?.companyId
      ? await Company.findById(report.userId.companyId).exec()
      : null;

    // Company settings not used in this function

    // Get approval instance for approver information
    const approvalInstance = await ApprovalInstance.findOne({ requestId: report._id })
      .populate('history.approverId', 'name email')
      .populate('history.roleId', 'name')
      .exec();

    const workbook = new ExcelJS.Workbook();

    // Summary sheet with enhanced information
    const summarySheet = workbook.addWorksheet('Summary');

    // Add company branding if available
    let currentRow = 1;
    if (company?.name) {
      summarySheet.addRow([`${company.name} - Expense Report Summary`]);
      summarySheet.getCell(currentRow, 1).font = { bold: true, size: 16 };
      summarySheet.mergeCells(`A${currentRow}:B${currentRow}`);
      currentRow += 2;
    } else {
      summarySheet.addRow(['Expense Report Summary']);
      summarySheet.getCell(currentRow, 1).font = { bold: true, size: 16 };
      currentRow += 2;
    }

    // Basic report information
    summarySheet.addRow(['Report Name', report.name]);
    summarySheet.addRow(['Owner', report.userId?.name || report.userId?.email]);
    summarySheet.addRow(['Project', report.projectId?.name || 'N/A']);
    summarySheet.addRow(['From Date', report.fromDate]);
    summarySheet.addRow(['To Date', report.toDate]);
    summarySheet.addRow(['Status', report.status]);

    // Status-based date information
    if (report.status === 'SUBMITTED' && report.submittedAt) {
      summarySheet.addRow(['Submitted Date', new Date(report.submittedAt).toLocaleDateString()]);
    } else if (report.status === 'APPROVED' && report.approvedAt) {
      summarySheet.addRow(['Approved Date', new Date(report.approvedAt).toLocaleDateString()]);
    } else if (report.status === 'REJECTED' && report.rejectedAt) {
      summarySheet.addRow(['Rejected Date', new Date(report.rejectedAt).toLocaleDateString()]);
    }

    // Currency and amount with proper symbol
    const currencySymbol = this.getCurrencySymbol(report.currency || 'INR');
    // Recalculate total from expenses to ensure accuracy
    const calculatedTotal = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
    summarySheet.addRow(['Total Amount', `${currencySymbol}${calculatedTotal.toFixed(2)}`]);

    // Add approver information
    if (approvalInstance?.history && approvalInstance.history.length > 0) {
      summarySheet.addRow([]);
      summarySheet.addRow(['Approval History']);
      summarySheet.addRow(['Approver', 'Role', 'Status', 'Date', 'Comments']);

      approvalInstance.history.forEach((historyItem: any) => {
        const approverName = historyItem.approverId?.name || historyItem.approverId?.email || 'Unknown';
        const roleName = historyItem.roleId?.name || 'Unknown';
        const status = historyItem.status;
        const date = historyItem.timestamp ? new Date(historyItem.timestamp).toLocaleDateString() : '';
        const comments = historyItem.comments || '';

        summarySheet.addRow([approverName, roleName, status, date, comments]);
      });
    }

    // Auto-size summary sheet columns
    summarySheet.columns.forEach((column) => {
      if (column.eachCell) {
        let maxLength = 0;
        column.eachCell({ includeEmpty: false }, (cell) => {
          const columnLength = cell.value ? cell.value.toString().length : 10;
          if (columnLength > maxLength) {
            maxLength = columnLength;
          }
        });
        column.width = maxLength < 15 ? 15 : maxLength + 2;
      }
    });

    // Expenses sheet
    const expensesSheet = workbook.addWorksheet('Expenses');
    expensesSheet.addRow(['Date', 'Vendor', 'Category', 'Amount', 'Currency', 'Notes', 'Receipt URL', 'Receipt Filename']);

    // Style header row
    const headerRow = expensesSheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    // Add expense rows with proper currency symbols
    expenses.forEach((exp) => {
      const receipt = exp.receiptPrimaryId as any;
      const receiptUrl = receipt?.storageUrl || '';
      const receiptFilename = receipt?.storageKey ? receipt.storageKey.split('/').pop() : '';
      const currencySymbol = this.getCurrencySymbol(exp.currency || 'INR');

      expensesSheet.addRow([
        exp.expenseDate,
        exp.vendor,
        exp.categoryId?.name || 'N/A',
        exp.amount,
        `${currencySymbol}${exp.currency}`,
        exp.notes || '',
        receiptUrl,
        receiptFilename,
      ]);
    });

    // Auto-size columns
    expensesSheet.columns.forEach((column) => {
      if (column.eachCell) {
        let maxLength = 0;
        column.eachCell({ includeEmpty: false }, (cell) => {
          const columnLength = cell.value ? cell.value.toString().length : 10;
          if (columnLength > maxLength) {
            maxLength = columnLength;
          }
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      }
    });

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }



  /**
   * Generate bulk Excel export with structured Expense Reimbursement Forms
   * Each report gets its own worksheet in the Excel file
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
    // Build query (same as generateBulkCSV)
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

    // Get all matching reports with enhanced population
    const reports = await ExpenseReport.find(query)
      .populate({
        path: 'userId',
        select: 'name email employeeId managerId departmentId companyId',
        populate: [
          { path: 'managerId', select: 'name email' },
          { path: 'departmentId', select: 'name' },
        ],
      })
      .populate('projectId', 'name code')
      .populate('costCentreId', 'name code')
      .sort({ fromDate: 1 })
      .exec();

    if (reports.length === 0) {
      // Return empty workbook
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('No Reports');
      worksheet.addRow(['No reports found matching the selected filters.']);
      return Buffer.from(await workbook.xlsx.writeBuffer());
    }

    // Create workbook
    const workbook = new ExcelJS.Workbook();

    for (const report of reports) {
      const expenses = await Expense.find({ reportId: report._id, status: { $ne: ExpenseStatus.REJECTED } })
        .populate('categoryId', 'name')
        .populate('receiptPrimaryId', 'storageUrl storageKey')
        .sort({ expenseDate: 1 })
        .exec();

      // Generate structured XLSX for this report using the same method
      // We'll create the worksheet directly in the main workbook
      const user = report.userId as any;
      const costCentre = report.costCentreId as any;

      // Get company and approval information
      const company = user?.companyId
        ? await Company.findById(user.companyId).exec()
        : null;

      const approvalInstance = await ApprovalInstance.findOne({ requestId: report._id })
        .populate('history.approverId', 'name email')
        .populate('history.roleId', 'name')
        .exec();

      // Sanitize worksheet name
      const sanitizedName = (report.name || `Report_${(report._id as mongoose.Types.ObjectId).toString().substring(0, 8)}`)
        .replace(/[\\\/\?\*\[\]:]/g, '_')
        .substring(0, 31); // Excel sheet name limit

      const worksheet = workbook.addWorksheet(sanitizedName);

      // Format dates
      const formatDate = (date: Date | string) => {
        if (!date) return '';
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
      };

      // Company branding and title
      let currentRow = 1;
      if (company?.name) {
        worksheet.addRow([`${company.name} - Expense Reimbursement Form`]);
        worksheet.mergeCells(currentRow, 1, currentRow, 9);
        const titleCell = worksheet.getCell(currentRow, 1);
        titleCell.font = { bold: true, size: 16 };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
        currentRow += 2;
      } else {
        worksheet.addRow([]);
        worksheet.mergeCells(currentRow, 1, currentRow, 9);
        const titleCell = worksheet.getCell(currentRow, 1);
        titleCell.value = 'Expense Reimbursement Form';
        titleCell.font = { bold: true, size: 16 };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
        currentRow += 2;
      }

      // Header Section
      worksheet.addRow(['Employee Name', user?.name || 'N/A']);
      worksheet.addRow(['Employee ID', user?.employeeId || 'N/A']);

      // Add approver information instead of just manager
      if (approvalInstance?.history && approvalInstance.history.length > 0) {
        const approvedBy = approvalInstance.history
          .filter((h: any) => h.status === 'APPROVED')
          .map((h: any) => h.approverId?.name || h.approverId?.email || 'Unknown')
          .join(', ');
        worksheet.addRow(['Approved By', approvedBy || 'Pending Approval']);
      } else {
        worksheet.addRow(['Approved By', 'Pending Approval']);
      }

      worksheet.addRow(['Cost Centre', costCentre?.name || costCentre?.code || 'N/A']);
      worksheet.addRow(['Start Date', formatDate(report.fromDate)]);
      worksheet.addRow(['End Date', formatDate(report.toDate)]);

      // Status-based date information
      if (report.status === 'SUBMITTED' && report.submittedAt) {
        worksheet.addRow(['Submitted Date', formatDate(report.submittedAt)]);
      } else if (report.status === 'APPROVED' && report.approvedAt) {
        worksheet.addRow(['Approved Date', formatDate(report.approvedAt)]);
      } else if (report.status === 'REJECTED' && report.rejectedAt) {
        worksheet.addRow(['Rejected Date', formatDate(report.rejectedAt)]);
      }

      worksheet.addRow(['Purpose of Expense', report.notes || report.name || 'N/A']);
      worksheet.addRow([]);

      // Voucher breakdown and liability (plan §7.1)
      const appliedVouchers = report.appliedVouchers || [];
      const voucherTotalUsed = appliedVouchers.length > 0
        ? appliedVouchers.reduce((s: number, a: any) => s + (a.amountUsed || 0), 0)
        : (report.advanceAppliedAmount ?? 0);
      const employeePaid = Math.max(0, (report.totalAmount ?? 0) - voucherTotalUsed);
      if (voucherTotalUsed > 0) {
        worksheet.addRow(['Voucher Applied', 'Yes']);
        appliedVouchers.forEach((v: any) => {
          worksheet.addRow(['Voucher', `${v.voucherCode || 'N/A'}: ${v.amountUsed ?? 0} ${v.currency ?? 'INR'}`]);
        });
        worksheet.addRow(['Voucher total used', `${report.currency ?? 'INR'} ${voucherTotalUsed.toFixed(2)}`]);
        worksheet.addRow(['Employee paid', `${report.currency ?? 'INR'} ${employeePaid.toFixed(2)}`]);
        worksheet.addRow([]);
      }

      // Expense Details Table Header (plan §7.1: duplicate columns)
      const headerRow = worksheet.addRow([
        'S. No',
        'Bill / Invoice No',
        'Bill / Invoice Date',
        'Type of Reimbursement',
        'Payment Method',
        'Currency',
        'Amount',
        'Receipt Attached',
        'Description',
        'Duplicate',
        'Duplicate Reason',
      ]);
      headerRow.font = { bold: true };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' },
      };
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
      headerRow.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });

      // Expense rows (plan §7.1: duplicate flags)
      let serialNumber = 1;
      expenses.forEach((exp) => {
        const category = (exp.categoryId as any)?.name || 'Other';
        const hasReceipt = !!(exp.receiptPrimaryId || (exp.receiptIds && exp.receiptIds.length > 0));
        const row = worksheet.addRow([
          serialNumber++,
          exp.invoiceId || exp.vendor || 'N/A',
          formatDate(exp.invoiceDate || exp.expenseDate),
          category,
          'N/A',
          exp.currency || 'INR',
          exp.amount || 0,
          hasReceipt ? 'Yes' : 'No',
          exp.notes || exp.vendor || '',
          exp.duplicateFlag || '',
          exp.duplicateReason || '',
        ]);
        row.eachCell((cell, colNumber) => {
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' },
          };
          if (colNumber === 7) {
            cell.numFmt = '#,##0.00';
            cell.alignment = { horizontal: 'right' };
          }
        });
      });

      const total = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
      const currency = report.currency || expenses[0]?.currency || 'INR';
      const totalRow = worksheet.addRow([
        'Subtotal',
        '',
        '',
        '',
        '',
        currency,
        total,
        '',
        '',
        '',
        '',
      ]);
      totalRow.font = { bold: true };
      totalRow.getCell(7).numFmt = '#,##0.00';
      totalRow.getCell(7).alignment = { horizontal: 'right' };
      totalRow.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
      if (voucherTotalUsed > 0) {
        const liabRow = worksheet.addRow(['Voucher used', '', '', '', '', currency, voucherTotalUsed, '', '', '', '']);
        liabRow.getCell(7).numFmt = '#,##0.00';
        liabRow.getCell(7).alignment = { horizontal: 'right' };
        const empRow = worksheet.addRow(['Employee paid', '', '', '', '', currency, employeePaid, '', '', '', '']);
        empRow.getCell(7).numFmt = '#,##0.00';
        empRow.getCell(7).alignment = { horizontal: 'right' };
      }
      worksheet.addRow([]);

      // Footer
      worksheet.addRow(['Don\'t forget to attach the receipts']);
      worksheet.addRow([]);
      worksheet.addRow(['Employee Signature:', '']);
      worksheet.addRow(['Date of Submission:', formatDate(report.submittedAt || report.updatedAt || new Date())]);

      worksheet.getColumn(1).width = 10;
      worksheet.getColumn(2).width = 20;
      worksheet.getColumn(3).width = 18;
      worksheet.getColumn(4).width = 25;
      worksheet.getColumn(5).width = 18;
      worksheet.getColumn(6).width = 12;
      worksheet.getColumn(7).width = 15;
      worksheet.getColumn(8).width = 18;
      worksheet.getColumn(9).width = 30;
      worksheet.getColumn(10).width = 14;
      worksheet.getColumn(11).width = 24;
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private static async generatePDF(report: any, expenses: any[]): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Get company details, settings, and approver information
        const company = report.userId?.companyId
          ? await Company.findById(report.userId.companyId).exec()
          : null;

        // Company settings not used in this function

        // Get approval instance for approver information
        const approvalInstance = await ApprovalInstance.findOne({ requestId: report._id })
          .populate('history.approverId', 'name email')
          .populate('history.roleId', 'name')
          .exec();

        // Get company logo if available
        let logoBuffer: Buffer | null = null;
        if (company?.logoUrl && typeof company.logoUrl === 'string') {
          try {
            // Fetch logo image from S3 URL
            const https = await import('https');
            const http = await import('http');
            const url = new URL(company.logoUrl);
            const client = url.protocol === 'https:' ? https : http;

            logoBuffer = await new Promise<Buffer>((resolveLogo, rejectLogo) => {
              client.get(company.logoUrl!, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolveLogo(Buffer.concat(chunks)));
                res.on('error', rejectLogo);
              }).on('error', rejectLogo);
            });
          } catch (error) {
            // Log but don't fail PDF generation if logo fails
            logger.error({ error }, 'Error loading company logo');
          }
        }

        // Header with company branding
        let yPosition = 50;
        if (logoBuffer) {
          try {
            (doc as any).image(logoBuffer, 50, yPosition, { width: 100, height: 50 });
            yPosition += 60;
          } catch (error) {
            logger.error({ error }, 'Error adding logo to PDF');
          }
        }

        // Company name and report title
        if (company?.name) {
          doc.fontSize(16).text(company.name, { align: 'center' });
          yPosition = doc.y + 10;
        }

        doc.fontSize(20).text('Expense Report', 50, yPosition, { align: 'center' });

        // Add "Powered by AI Ally" text
        (doc as any).fontSize(8).fillColor('gray').text('Powered by AI Ally', { align: 'right' });
        (doc as any).fillColor('black');
        doc.moveDown();

        // Summary section
        doc.fontSize(14).text('Summary', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(12);
        doc.text(`Report Name: ${report.name}`);
        doc.text(`Owner: ${report.userId?.name || report.userId?.email}`);
        doc.text(`Project: ${report.projectId?.name || 'N/A'}`);
        doc.text(`From Date: ${report.fromDate.toISOString().split('T')[0]}`);
        doc.text(`To Date: ${report.toDate.toISOString().split('T')[0]}`);
        doc.text(`Status: ${report.status}`);

        // Status-based date information
        if (report.status === 'SUBMITTED' && report.submittedAt) {
          doc.text(`Submitted Date: ${new Date(report.submittedAt).toLocaleDateString()}`);
        } else if (report.status === 'APPROVED' && report.approvedAt) {
          doc.text(`Approved Date: ${new Date(report.approvedAt).toLocaleDateString()}`);
        } else if (report.status === 'REJECTED' && report.rejectedAt) {
          doc.text(`Rejected Date: ${new Date(report.rejectedAt).toLocaleDateString()}`);
        }

        const currencySymbol = this.getCurrencySymbol(report.currency || 'INR');
        const calculatedTotal = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
        doc.text(`Total Amount: ${currencySymbol}${calculatedTotal.toFixed(2)}`);
        const appliedVouchers = report.appliedVouchers || [];
        const voucherTotalUsed = appliedVouchers.length > 0
          ? appliedVouchers.reduce((s: number, a: any) => s + (a.amountUsed || 0), 0)
          : (report.advanceAppliedAmount ?? 0);
        const employeePaid = Math.max(0, calculatedTotal - voucherTotalUsed);
        if (voucherTotalUsed > 0) {
          doc.text(`Voucher Applied: Yes`);
          appliedVouchers.forEach((v: any) => {
            doc.text(`  ${v.voucherCode || 'N/A'}: ${currencySymbol}${(v.amountUsed ?? 0).toFixed(2)}`);
          });
          doc.text(`Voucher total used: ${currencySymbol}${voucherTotalUsed.toFixed(2)}`);
          doc.text(`Employee paid: ${currencySymbol}${employeePaid.toFixed(2)}`);
        }
        doc.moveDown();

        // Add approver information
        if (approvalInstance?.history && approvalInstance.history.length > 0) {
          doc.fontSize(14).text('Approval History', { underline: true });
          doc.moveDown(0.5);
          doc.fontSize(10);

          approvalInstance.history.forEach((historyItem: any) => {
            const approverName = historyItem.approverId?.name || historyItem.approverId?.email || 'Unknown';
            const roleName = historyItem.roleId?.name || 'Unknown';
            const status = historyItem.status;
            const date = historyItem.timestamp ? new Date(historyItem.timestamp).toLocaleDateString() : '';
            const comments = historyItem.comments || '';

            doc.text(`${approverName} (${roleName}) - ${status} on ${date}`);
            if (comments) {
              doc.text(`Comments: ${comments}`);
            }
            doc.moveDown(0.5);
          });
          doc.moveDown();
        }

        // Expenses table
        doc.fontSize(14).text('Expenses', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(10);

        const tableTop = doc.y;
        doc.fontSize(8);
        doc.text('Date', 50, tableTop);
        doc.text('Vendor', 100, tableTop);
        doc.text('Category', 200, tableTop);
        doc.text('Amount', 280, tableTop);
        doc.text('Invoice ID', 350, tableTop);
        doc.text('Dup', 420, tableTop);
        doc.text('Notes', 455, tableTop);

        let y = tableTop + 20;
        expenses.forEach((exp) => {
          if (y > 700) {
            doc.addPage();
            y = 50;
          }
          doc.fontSize(8);
          doc.text(exp.expenseDate.toISOString().split('T')[0], 50, y);
          doc.text(exp.vendor.substring(0, 25), 100, y);
          doc.text((exp.categoryId?.name || 'N/A').substring(0, 15), 200, y);
          const sym = this.getCurrencySymbol(exp.currency || 'INR');
          doc.text(`${sym}${exp.amount}`, 280, y);
          doc.text((exp.invoiceId || 'N/A').substring(0, 15), 350, y);
          doc.text((exp.duplicateFlag || '').substring(0, 6), 420, y);
          doc.text((exp.notes || '').substring(0, 20), 455, y);
          y += 20;
        });

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Generate structured Expense Reimbursement Form export (Excel)
   * Matches finance/audit requirements with proper layout
   */
  static async generateStructuredExport(
    reportId: string,
    requestingUserId: string,
    requestingUserRole: string
  ): Promise<Buffer> {
    const report = await ExpenseReport.findById(reportId)
      .populate({
        path: 'userId',
        select: 'name email employeeId managerId departmentId',
        populate: [
          { path: 'managerId', select: 'name email' },
          { path: 'departmentId', select: 'name' },
        ],
      })
      .populate('projectId', 'name code')
      .populate('costCentreId', 'name code')
      .exec();

    if (!report) {
      throw new Error('Report not found');
    }

    // Check authorization
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

    // Only allow export for approved/submitted reports (or draft if owner)
    // Company admins can export any report regardless of status
    const allowedStatuses = ['SUBMITTED', 'APPROVED', 'MANAGER_APPROVED', 'BH_APPROVED', 'DRAFT'];
    if (!isOwner && !isAdmin && !allowedStatuses.includes(report.status)) {
      const error: any = new Error('Report must be submitted or approved to export');
      error.statusCode = 400;
      throw error;
    }

    const expenses = await Expense.find({ reportId, status: { $ne: ExpenseStatus.REJECTED } })
      .populate('categoryId', 'name')
      .populate('receiptPrimaryId', 'storageUrl storageKey')
      .sort({ expenseDate: 1 })
      .exec();

    return await this.generateStructuredXLSX(report as any, expenses);
  }

  /**
   * Generate structured Excel with Expense Reimbursement Form layout
   */
  private static async generateStructuredXLSX(report: any, expenses: any[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Expense Reimbursement Form');

    const user = report.userId as any;
    const costCentre = report.costCentreId as any;

    // Get company and approval information
    const company = user?.companyId
      ? await Company.findById(user.companyId).exec()
      : null;

    const approvalInstance = await ApprovalInstance.findOne({ requestId: report._id })
      .populate('history.approverId', 'name email')
      .populate('history.roleId', 'name')
      .exec();

    // Format dates
    const formatDate = (date: Date | string) => {
      if (!date) return '';
      const d = new Date(date);
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    };

    let currentRow = 1;

    // Row 1: Company branding and title (merged cells)
    if (company?.name) {
      worksheet.mergeCells(`A${currentRow}:H${currentRow}`);
      const titleCell = worksheet.getCell(`A${currentRow}`);
      titleCell.value = `${company.name} - Expense Reimbursement Form`;
      titleCell.font = { size: 18, bold: true };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    } else {
      worksheet.mergeCells(`A${currentRow}:H${currentRow}`);
      const titleCell = worksheet.getCell(`A${currentRow}`);
      titleCell.value = 'Expense Reimbursement Form';
      titleCell.font = { size: 18, bold: true };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    currentRow += 2;

    // Header Section
    const headerData = [
      ['Employee Name', user?.name || 'N/A'],
      ['Employee ID', user?.employeeId || 'N/A'],
    ];

    // Add approver information
    if (approvalInstance?.history && approvalInstance.history.length > 0) {
      const approvedBy = approvalInstance.history
        .filter((h: any) => h.status === 'APPROVED')
        .map((h: any) => h.approverId?.name || h.approverId?.email || 'Unknown')
        .join(', ');
      headerData.push(['Approved By', approvedBy || 'Pending Approval']);
    } else {
      headerData.push(['Approved By', 'Pending Approval']);
    }

    headerData.push(
      ['Cost Centre', costCentre?.name || costCentre?.code || 'N/A'],
      ['Start Date', formatDate(report.fromDate)],
      ['End Date', formatDate(report.toDate)]
    );

    // Status-based date information
    if (report.status === 'SUBMITTED' && report.submittedAt) {
      headerData.push(['Submitted Date', formatDate(report.submittedAt)]);
    } else if (report.status === 'APPROVED' && report.approvedAt) {
      headerData.push(['Approved Date', formatDate(report.approvedAt)]);
    } else if (report.status === 'REJECTED' && report.rejectedAt) {
      headerData.push(['Rejected Date', formatDate(report.rejectedAt)]);
    }

    headerData.push(['Purpose of Expense', report.notes || report.name || 'N/A']);

    const appliedVouchers = report.appliedVouchers || [];
    const voucherTotalUsed = appliedVouchers.length > 0
      ? appliedVouchers.reduce((s: number, a: any) => s + (a.amountUsed || 0), 0)
      : (report.advanceAppliedAmount ?? 0);
    const reportTotal = report.totalAmount ?? expenses.reduce((s: number, e: any) => s + (e.amount || 0), 0);
    const employeePaid = Math.max(0, reportTotal - voucherTotalUsed);
    if (voucherTotalUsed > 0) {
      headerData.push(['Voucher Applied', 'Yes']);
      appliedVouchers.forEach((v: any) => {
        headerData.push(['Voucher', `${v.voucherCode || 'N/A'}: ${v.amountUsed ?? 0} ${v.currency ?? 'INR'}`]);
      });
      headerData.push(['Voucher total used', `${report.currency ?? 'INR'} ${voucherTotalUsed.toFixed(2)}`]);
      headerData.push(['Employee paid', `${report.currency ?? 'INR'} ${employeePaid.toFixed(2)}`]);
    }

    headerData.forEach(([label, value]) => {
      const labelCell = worksheet.getCell(`A${currentRow}`);
      labelCell.value = label;
      labelCell.font = { bold: true };
      labelCell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };

      const valueCell = worksheet.getCell(`B${currentRow}`);
      valueCell.value = value;
      valueCell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };

      // Merge B to H for value
      worksheet.mergeCells(`B${currentRow}:H${currentRow}`);
      currentRow++;
    });

    currentRow += 1; // Empty row

    const headers = [
      'S. No',
      'Bill / Invoice No',
      'Bill / Invoice Date',
      'Type of Reimbursement',
      'Payment Method',
      'Currency',
      'Amount',
      'Receipt Attached',
      'Description',
      'Duplicate',
      'Duplicate Reason',
    ];

    headers.forEach((header, index) => {
      const cell = worksheet.getCell(currentRow, index + 1);
      cell.value = header;
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' },
      };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
    currentRow++;

    // Expense rows
    let serialNumber = 1;
    expenses.forEach((exp) => {
      const category = (exp.categoryId as any)?.name || 'Other';
      const hasReceipt = !!(exp.receiptPrimaryId || (exp.receiptIds && exp.receiptIds.length > 0));
      
      const rowData = [
        serialNumber++,
        exp.invoiceId || exp.vendor || 'N/A',
        formatDate(exp.invoiceDate || exp.expenseDate),
        category,
        'N/A',
        exp.currency || 'INR',
        exp.amount || 0,
        hasReceipt ? 'Yes' : 'No',
        exp.notes || exp.vendor || '',
        exp.duplicateFlag || '',
        exp.duplicateReason || '',
      ];

      rowData.forEach((value, index) => {
        const cell = worksheet.getCell(currentRow, index + 1);
        cell.value = value;
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
        if (index === 6) { // Amount column
          cell.numFmt = '#,##0.00';
          cell.alignment = { horizontal: 'right' };
        } else if (index === 0) { // S. No
          cell.alignment = { horizontal: 'center' };
        }
      });
      currentRow++;
    });

    // Empty row
    currentRow++;

    // Subtotal row
    const total = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
    const currency = report.currency || expenses[0]?.currency || 'INR';
    
    worksheet.mergeCells(`A${currentRow}:F${currentRow}`);
    const subtotalLabelCell = worksheet.getCell(`A${currentRow}`);
    subtotalLabelCell.value = 'Subtotal';
    subtotalLabelCell.font = { bold: true };
    subtotalLabelCell.alignment = { horizontal: 'right' };
    subtotalLabelCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };

    const currencyCell = worksheet.getCell(`G${currentRow}`);
    currencyCell.value = currency;
    currencyCell.font = { bold: true };
    currencyCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };

    const amountCell = worksheet.getCell(`H${currentRow}`);
    amountCell.value = total;
    amountCell.numFmt = '#,##0.00';
    amountCell.font = { bold: true };
    amountCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
    currentRow++;
    if (voucherTotalUsed > 0) {
      const border = { top: { style: 'thin' as const }, left: { style: 'thin' as const }, bottom: { style: 'thin' as const }, right: { style: 'thin' as const } };
      worksheet.mergeCells(`A${currentRow}:F${currentRow}`);
      const vLab = worksheet.getCell(`A${currentRow}`);
      vLab.value = 'Voucher used';
      vLab.font = { bold: true };
      vLab.alignment = { horizontal: 'right' };
      vLab.border = border;
      const g1 = worksheet.getCell(`G${currentRow}`);
      g1.value = report.currency ?? 'INR';
      g1.font = { bold: true };
      g1.border = border;
      const h1 = worksheet.getCell(`H${currentRow}`);
      h1.value = voucherTotalUsed;
      h1.numFmt = '#,##0.00';
      h1.font = { bold: true };
      h1.border = border;
      currentRow++;
      worksheet.mergeCells(`A${currentRow}:F${currentRow}`);
      const eLab = worksheet.getCell(`A${currentRow}`);
      eLab.value = 'Employee paid';
      eLab.font = { bold: true };
      eLab.alignment = { horizontal: 'right' };
      eLab.border = border;
      const g2 = worksheet.getCell(`G${currentRow}`);
      g2.value = report.currency ?? 'INR';
      g2.font = { bold: true };
      g2.border = border;
      const h2 = worksheet.getCell(`H${currentRow}`);
      h2.value = employeePaid;
      h2.numFmt = '#,##0.00';
      h2.font = { bold: true };
      h2.border = border;
      currentRow++;
    }
    currentRow++;

    // Footer note
    worksheet.mergeCells(`A${currentRow}:H${currentRow}`);
    const noteCell = worksheet.getCell(`A${currentRow}`);
    noteCell.value = "Don't forget to attach the receipts";
    noteCell.font = { italic: true };
    noteCell.alignment = { horizontal: 'center' };
    currentRow += 2;

    // Employee Signature
    worksheet.mergeCells(`A${currentRow}:D${currentRow}`);
    const signatureLabelCell = worksheet.getCell(`A${currentRow}`);
    signatureLabelCell.value = 'Employee Signature:';
    signatureLabelCell.font = { bold: true };
    currentRow++;

    worksheet.mergeCells(`A${currentRow}:D${currentRow}`);
    const signatureCell = worksheet.getCell(`A${currentRow}`);
    signatureCell.border = {
      bottom: { style: 'thin' },
    };
    currentRow += 2;

    // Date of Submission
    worksheet.mergeCells(`A${currentRow}:D${currentRow}`);
    const dateLabelCell = worksheet.getCell(`A${currentRow}`);
    dateLabelCell.value = 'Date of Submission:';
    dateLabelCell.font = { bold: true };
    currentRow++;

    worksheet.mergeCells(`A${currentRow}:D${currentRow}`);
    const dateCell = worksheet.getCell(`A${currentRow}`);
    dateCell.value = formatDate(report.submittedAt || report.updatedAt || new Date());
    dateCell.border = {
      bottom: { style: 'thin' },
    };

    worksheet.getColumn(1).width = 8;
    worksheet.getColumn(2).width = 20;
    worksheet.getColumn(3).width = 18;
    worksheet.getColumn(4).width = 25;
    worksheet.getColumn(5).width = 18;
    worksheet.getColumn(6).width = 12;
    worksheet.getColumn(7).width = 15;
    worksheet.getColumn(8).width = 18;
    worksheet.getColumn(9).width = 30;
    worksheet.getColumn(10).width = 12;
    worksheet.getColumn(11).width = 22;

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

}


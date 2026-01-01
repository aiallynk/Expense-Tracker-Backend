import { randomUUID } from 'crypto';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import mongoose from 'mongoose';

import { s3Client, getS3Bucket } from '../config/aws';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { CostCentre } from '../models/CostCentre';
import { Project } from '../models/Project';
import { CompanySettings } from '../models/CompanySettings';
import { ExportFormat } from '../utils/enums';
import { getObjectUrl } from '../utils/s3';
import { getFinancialYear } from '../utils/financialYear';

// import { logger } from '@/config/logger'; // Unused

export class ExportService {
  static async generateExport(
    reportId: string,
    format: ExportFormat
  ): Promise<{ downloadUrl: string; storageKey: string }> {
    const report = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email')
      .populate('projectId', 'name code')
      .exec();

    if (!report) {
      throw new Error('Report not found');
    }

    const expenses = await Expense.find({ reportId })
      .populate('categoryId', 'name')
      .populate('receiptPrimaryId', 'storageUrl storageKey mimeType')
      .sort({ expenseDate: 1 })
      .exec();

    let buffer: Buffer;
    let mimeType: string;
    let fileExtension: string;

    switch (format) {
      case ExportFormat.XLSX:
        buffer = await this.generateXLSX(report as any, expenses);
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        fileExtension = 'xlsx';
        break;
      case ExportFormat.CSV:
        // Get company settings for financial year config
        const user = report.userId as any;
        let companySettings = null;
        if (user?.companyId) {
          companySettings = await CompanySettings.findOne({ companyId: user.companyId }).exec();
        }
        buffer = await this.generateCSV(report as any, expenses, companySettings);
        mimeType = 'text/csv';
        fileExtension = 'csv';
        break;
      case ExportFormat.PDF:
        buffer = await this.generatePDF(report as any, expenses);
        mimeType = 'application/pdf';
        fileExtension = 'pdf';
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    // Upload to S3
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
    const workbook = new ExcelJS.Workbook();

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.addRow(['Expense Report Summary']);
    summarySheet.addRow([]);
    summarySheet.addRow(['Report Name', report.name]);
    summarySheet.addRow(['Owner', report.userId?.name || report.userId?.email]);
    summarySheet.addRow(['Project', report.projectId?.name || 'N/A']);
    summarySheet.addRow(['From Date', report.fromDate]);
    summarySheet.addRow(['To Date', report.toDate]);
    summarySheet.addRow(['Status', report.status]);
    summarySheet.addRow(['Total Amount', `${report.currency} ${report.totalAmount}`]);

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

    // Add expense rows
    expenses.forEach((exp) => {
      const receipt = exp.receiptPrimaryId as any;
      const receiptUrl = receipt?.storageUrl || '';
      const receiptFilename = receipt?.storageKey ? receipt.storageKey.split('/').pop() : '';
      
      expensesSheet.addRow([
        exp.expenseDate,
        exp.vendor,
        exp.categoryId?.name || 'N/A',
        exp.amount,
        exp.currency,
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
   * Generate CSV aligned with Ellora EPC template structure
   * Columns: Financial Year, Report ID, Report Name, Employee Name, Employee Email, 
   *          Cost Centre Code, Cost Centre Name, Project Code, Project Name,
   *          Expense Date, Invoice ID, Invoice Date, Vendor, Category, Amount, Currency, Notes, Status
   */
  private static async generateCSV(
    report: any, 
    expenses: any[],
    companySettings?: any
  ): Promise<Buffer> {
    const lines: string[] = [];

    // Get financial year configuration
    const fyConfig = companySettings?.financialYear || {
      startMonth: 4,
      startDay: 1,
      endMonth: 3,
      endDay: 31,
    };

    // Get financial year for report date
    const reportDate = new Date(report.fromDate);
    const fy = getFinancialYear(reportDate, fyConfig);

    // Get cost centre and project details
    const costCentre = report.costCentreId 
      ? await CostCentre.findById(report.costCentreId).exec()
      : null;
    const project = report.projectId
      ? await Project.findById(report.projectId).exec()
      : null;

    // CSV Header - Ellora EPC Template Structure
    const header = [
      'Financial Year',
      'Report ID',
      'Report Name',
      'Employee Name',
      'Employee Email',
      'Cost Centre Code',
      'Cost Centre Name',
      'Project Code',
      'Project Name',
      'Expense Date',
      'Invoice ID',
      'Invoice Date',
      'Vendor',
      'Category',
      'Amount',
      'Currency',
      'Notes',
      'Report Status',
      'Submitted Date',
      'Approved Date',
    ];
    lines.push(header.join(','));

    // Expense rows
    expenses.forEach((exp) => {
      const expenseDate = new Date(exp.expenseDate);
      const invoiceDate = exp.invoiceDate ? new Date(exp.invoiceDate).toISOString().split('T')[0] : '';
      
      const row = [
        fy.year, // Financial Year
        (report._id as mongoose.Types.ObjectId).toString(), // Report ID
        `"${(report.name || '').replace(/"/g, '""')}"`, // Report Name (quoted, escape quotes)
        `"${((report.userId?.name || '') || '').replace(/"/g, '""')}"`, // Employee Name
        report.userId?.email || '', // Employee Email
        costCentre?.code || '', // Cost Centre Code
        `"${(costCentre?.name || '').replace(/"/g, '""')}"`, // Cost Centre Name
        project?.code || '', // Project Code
        `"${(project?.name || '').replace(/"/g, '""')}"`, // Project Name
        expenseDate.toISOString().split('T')[0], // Expense Date
        exp.invoiceId || '', // Invoice ID
        invoiceDate, // Invoice Date
        `"${(exp.vendor || '').replace(/"/g, '""')}"`, // Vendor
        `"${((exp.categoryId?.name || 'N/A') || '').replace(/"/g, '""')}"`, // Category
        exp.amount.toString(), // Amount
        exp.currency || 'INR', // Currency
        `"${((exp.notes || '').replace(/"/g, '""')).replace(/,/g, ';')}"`, // Notes (escape quotes, replace commas)
        report.status, // Report Status
        report.submittedAt ? new Date(report.submittedAt).toISOString().split('T')[0] : '', // Submitted Date
        report.approvedAt ? new Date(report.approvedAt).toISOString().split('T')[0] : '', // Approved Date
      ];
      lines.push(row.join(','));
    });

    return Buffer.from(lines.join('\n'), 'utf-8');
  }

  /**
   * Generate bulk CSV export with filtering
   * For Admin & Accountant roles only
   */
  static async generateBulkCSV(
    filters: {
      financialYear?: string; // e.g., "2024-25"
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

    // Status filter
    if (filters.status) {
      query.status = filters.status;
    }

    // Cost Centre filter
    if (filters.costCentreId) {
      query.costCentreId = new mongoose.Types.ObjectId(filters.costCentreId);
    }

    // Project filter
    if (filters.projectId) {
      query.projectId = new mongoose.Types.ObjectId(filters.projectId);
    }

    // Company filter
    if (filters.companyId) {
      const { User } = await import('../models/User');
      const companyUsers = await User.find({ companyId: filters.companyId }).select('_id').exec();
      const userIds = companyUsers.map(u => u._id);
      query.userId = { $in: userIds };
    }

    // Date range filter
    if (filters.fromDate || filters.toDate) {
      query.fromDate = {};
      if (filters.fromDate) {
        query.fromDate.$gte = filters.fromDate;
      }
      if (filters.toDate) {
        query.toDate = { $lte: filters.toDate };
      }
    }

    // Financial Year filter
    if (filters.financialYear) {
      // Parse FY string (e.g., "2024-25")
      const [startYearStr] = filters.financialYear.split('-');
      const startYear = parseInt(startYearStr.replace('FY', ''));
      
      // Get company settings for FY config
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

    const lines: string[] = [];

    // Process each report with structured format
    for (const report of reports) {
      const expenses = await Expense.find({ reportId: report._id })
        .populate('categoryId', 'name')
        .populate('receiptPrimaryId', 'storageUrl storageKey')
        .sort({ expenseDate: 1 })
        .exec();

      // Generate structured CSV for this report
      const reportBuffer = await this.generateStructuredCSV(report as any, expenses);
      const reportCsv = reportBuffer.toString('utf-8');
      
      // Add report separator
      lines.push('');
      lines.push(`=== REPORT: ${report.name || 'Untitled Report'} (ID: ${(report._id as mongoose.Types.ObjectId).toString()}) ===`);
      lines.push('');
      
      // Add the structured CSV content
      lines.push(reportCsv);
      
      // Add separator between reports
      lines.push('');
      lines.push('='.repeat(80));
      lines.push('');
    }

    // Add UTF-8 BOM for Excel compatibility
    const csvContent = lines.join('\r\n');
    const utf8Bom = '\uFEFF';
    return Buffer.from(utf8Bom + csvContent, 'utf-8');
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

    // Get all matching reports
    const reports = await ExpenseReport.find(query)
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

    // Process each report and create a worksheet
    for (const report of reports) {
      const expenses = await Expense.find({ reportId: report._id })
        .populate('categoryId', 'name')
        .populate('receiptPrimaryId', 'storageUrl storageKey')
        .sort({ expenseDate: 1 })
        .exec();

      // Generate structured XLSX for this report using the same method
      // We'll create the worksheet directly in the main workbook
      const user = report.userId as any;
      const manager = user?.managerId as any;
      const costCentre = report.costCentreId as any;
      
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

      // Title Row
      worksheet.addRow([]);
      worksheet.mergeCells(1, 1, 1, 9);
      const titleCell = worksheet.getCell(1, 1);
      titleCell.value = 'Expense Reimbursement Form';
      titleCell.font = { bold: true, size: 16 };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
      worksheet.addRow([]);

      // Header Section
      worksheet.addRow(['Employee Name', user?.name || 'N/A']);
      worksheet.addRow(['Employee ID', user?.employeeId || 'N/A']);
      worksheet.addRow(['Reporting Manager', manager?.name || 'Unassigned']);
      worksheet.addRow(['Cost Centre', costCentre?.name || costCentre?.code || 'N/A']);
      worksheet.addRow(['Start Date', formatDate(report.fromDate)]);
      worksheet.addRow(['End Date', formatDate(report.toDate)]);
      worksheet.addRow(['Purpose of Expense', report.notes || report.name || 'N/A']);
      worksheet.addRow([]);

      // Expense Details Table Header
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

      // Expense rows
      let serialNumber = 1;
      expenses.forEach((exp) => {
        const category = (exp.categoryId as any)?.name || 'Other';
        const hasReceipt = !!(exp.receiptPrimaryId || (exp.receiptIds && exp.receiptIds.length > 0));
        
        const row = worksheet.addRow([
          serialNumber++,
          exp.invoiceId || exp.vendor || 'N/A',
          formatDate(exp.invoiceDate || exp.expenseDate),
          category,
          'N/A', // Payment Method
          exp.currency || 'INR',
          exp.amount || 0,
          hasReceipt ? 'Yes' : 'No',
          exp.notes || exp.vendor || '',
        ]);
        
        row.eachCell((cell, colNumber) => {
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' },
          };
          if (colNumber === 7) { // Amount column
            cell.numFmt = '#,##0.00';
            cell.alignment = { horizontal: 'right' };
          }
        });
      });

      // Totals Row
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
      worksheet.addRow([]);

      // Footer
      worksheet.addRow(['Don\'t forget to attach the receipts']);
      worksheet.addRow([]);
      worksheet.addRow(['Employee Signature:', '']);
      worksheet.addRow(['Date of Submission:', formatDate(report.submittedAt || report.updatedAt || new Date())]);

      // Set column widths
      worksheet.getColumn(1).width = 10; // S. No
      worksheet.getColumn(2).width = 20; // Bill/Invoice No
      worksheet.getColumn(3).width = 18; // Bill/Invoice Date
      worksheet.getColumn(4).width = 25; // Type of Reimbursement
      worksheet.getColumn(5).width = 18; // Payment Method
      worksheet.getColumn(6).width = 12; // Currency
      worksheet.getColumn(7).width = 15; // Amount
      worksheet.getColumn(8).width = 18; // Receipt Attached
      worksheet.getColumn(9).width = 30; // Description
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

        // Get company logo if available
        let logoBuffer: Buffer | null = null;
        if (report.userId?.companyId) {
          try {
            const { BrandingService } = await import('./branding.service');
            const logoUrl = await BrandingService.getLogoUrl(report.userId.companyId.toString());
            
            if (logoUrl) {
              // Fetch logo image
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
            }
          } catch (error) {
            // Log but don't fail PDF generation if logo fails
            console.error('Error loading company logo:', error);
          }
        }

        // Header with logo
        if (logoBuffer) {
          try {
            (doc as any).image(logoBuffer, 50, 50, { width: 100, height: 50 });
          } catch (error) {
            console.error('Error adding logo to PDF:', error);
          }
        }
        
        doc.fontSize(20).text('Expense Report', { align: 'center' });
        
        // Add "Powered by AI Ally" text
        (doc as any).fontSize(8).fillColor('gray').text('Powered by AI Ally', { align: 'right' });
        (doc as any).fillColor('black');
        doc.moveDown();

      // Summary
      doc.fontSize(14).text('Summary', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(12);
      doc.text(`Report Name: ${report.name}`);
      doc.text(`Owner: ${report.userId?.name || report.userId?.email}`);
      doc.text(`Project: ${report.projectId?.name || 'N/A'}`);
      doc.text(`From Date: ${report.fromDate.toISOString().split('T')[0]}`);
      doc.text(`To Date: ${report.toDate.toISOString().split('T')[0]}`);
      doc.text(`Status: ${report.status}`);
      doc.text(`Total Amount: ${report.currency} ${report.totalAmount}`);
      doc.moveDown();

        // Expenses table
        doc.fontSize(14).text('Expenses', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(10);

        // Table header
        const tableTop = doc.y;
        doc.fontSize(8);
        doc.text('Date', 50, tableTop);
        doc.text('Vendor', 100, tableTop);
        doc.text('Category', 200, tableTop);
        doc.text('Amount', 280, tableTop);
        doc.text('Invoice ID', 350, tableTop);
        doc.text('Notes', 420, tableTop);

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
          doc.text(`${exp.currency} ${exp.amount}`, 280, y);
          doc.text((exp.invoiceId || 'N/A').substring(0, 15), 350, y);
          doc.text((exp.notes || '').substring(0, 20), 420, y);
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
    format: 'xlsx' | 'csv',
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
      throw new Error('Unauthorized to export this report');
    }

    // Only allow export for approved/submitted reports (or draft if owner)
    const allowedStatuses = ['SUBMITTED', 'APPROVED', 'MANAGER_APPROVED', 'BH_APPROVED'];
    if (!isOwner && !allowedStatuses.includes(report.status)) {
      throw new Error('Report must be submitted or approved to export');
    }

    const expenses = await Expense.find({ reportId })
      .populate('categoryId', 'name')
      .populate('receiptPrimaryId', 'storageUrl storageKey')
      .sort({ expenseDate: 1 })
      .exec();

    if (format === 'xlsx') {
      return await this.generateStructuredXLSX(report as any, expenses);
    } else {
      return await this.generateStructuredCSV(report as any, expenses);
    }
  }

  /**
   * Generate structured Excel with Expense Reimbursement Form layout
   */
  private static async generateStructuredXLSX(report: any, expenses: any[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Expense Reimbursement Form');

    const user = report.userId as any;
    const manager = user?.managerId as any;
    const costCentre = report.costCentreId as any;

    // Format dates
    const formatDate = (date: Date | string) => {
      if (!date) return '';
      const d = new Date(date);
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    };

    let currentRow = 1;

    // Row 1: Title (merged cells)
    worksheet.mergeCells(`A${currentRow}:H${currentRow}`);
    const titleCell = worksheet.getCell(`A${currentRow}`);
    titleCell.value = 'Expense Reimbursement Form';
    titleCell.font = { size: 18, bold: true };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    currentRow += 2;

    // Header Section (Rows 3-9)
    const headerData = [
      ['Employee Name', user?.name || 'N/A'],
      ['Employee ID', user?.employeeId || 'N/A'],
      ['Reporting Manager', manager?.name || 'Unassigned'],
      ['Cost Centre', costCentre?.name || costCentre?.code || 'N/A'],
      ['Start Date', formatDate(report.fromDate)],
      ['End Date', formatDate(report.toDate)],
      ['Purpose of Expense', report.notes || report.name || 'N/A'],
    ];

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

    // Table Header (Row 11)
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
        exp.invoiceId || exp.vendor || 'N/A', // Bill/Invoice No
        formatDate(exp.invoiceDate || exp.expenseDate), // Bill/Invoice Date
        category, // Type of Reimbursement
        'N/A', // Payment Method (not stored in current schema)
        exp.currency || 'INR', // Currency
        exp.amount || 0, // Amount
        hasReceipt ? 'Yes' : 'No', // Receipt Attached
        exp.notes || exp.vendor || '', // Description
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
    currentRow += 2;

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

    // Set column widths
    worksheet.getColumn(1).width = 8; // S. No
    worksheet.getColumn(2).width = 20; // Bill/Invoice No
    worksheet.getColumn(3).width = 18; // Bill/Invoice Date
    worksheet.getColumn(4).width = 25; // Type of Reimbursement
    worksheet.getColumn(5).width = 18; // Payment Method
    worksheet.getColumn(6).width = 12; // Currency
    worksheet.getColumn(7).width = 15; // Amount
    worksheet.getColumn(8).width = 18; // Receipt Attached
    worksheet.getColumn(9).width = 30; // Description

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Generate structured CSV with Expense Reimbursement Form layout
   * Flattened format with clear section headers
   */
  private static async generateStructuredCSV(report: any, expenses: any[]): Promise<Buffer> {
    const lines: string[] = [];
    
    const user = report.userId as any;
    const manager = user?.managerId as any;
    const costCentre = report.costCentreId as any;

    // Format date for CSV - use DD/MM/YYYY format and quote it to prevent Excel from misinterpreting
    const formatDate = (date: Date | string) => {
      if (!date) return '';
      try {
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        // Quote the date to ensure Excel treats it as text/date, not a formula
        return `"${day}/${month}/${year}"`;
      } catch {
        return '';
      }
    };

    // Title - quote it to prevent Excel from treating it as a formula
    lines.push('"Expense Reimbursement Form"');
    lines.push('');

    // Header Section - use plain text headers without === to avoid formula interpretation
    lines.push('HEADER INFORMATION');
    lines.push(`Employee Name,"${(user?.name || 'N/A').replace(/"/g, '""')}"`);
    lines.push(`Employee ID,"${(user?.employeeId || 'N/A').replace(/"/g, '""')}"`);
    lines.push(`Reporting Manager,"${(manager?.name || 'Unassigned').replace(/"/g, '""')}"`);
    lines.push(`Cost Centre,"${(costCentre?.name || costCentre?.code || 'N/A').replace(/"/g, '""')}"`);
    lines.push(`Start Date,${formatDate(report.fromDate)}`);
    lines.push(`End Date,${formatDate(report.toDate)}`);
    lines.push(`Purpose of Expense,"${(report.notes || report.name || 'N/A').replace(/"/g, '""')}"`);
    lines.push('');

    // Expense Details Table
    lines.push('EXPENSE DETAILS');
    lines.push('S. No,Bill / Invoice No,Bill / Invoice Date,Type of Reimbursement,Payment Method,Currency,Amount,Receipt Attached,Description');

    let serialNumber = 1;
    expenses.forEach((exp) => {
      const category = (exp.categoryId as any)?.name || 'Other';
      const hasReceipt = !!(exp.receiptPrimaryId || (exp.receiptIds && exp.receiptIds.length > 0));
      const description = (exp.notes || exp.vendor || '').replace(/"/g, '""');
      const invoiceNo = (exp.invoiceId || exp.vendor || 'N/A').replace(/"/g, '""');
      
      // Format date properly for CSV
      const billDate = formatDate(exp.invoiceDate || exp.expenseDate);
      
      lines.push([
        serialNumber++,
        `"${invoiceNo}"`,
        billDate, // Already quoted in formatDate
        `"${category.replace(/"/g, '""')}"`,
        '"N/A"', // Payment Method - quoted
        `"${exp.currency || 'INR'}"`, // Currency - quoted
        exp.amount || 0, // Amount - numeric, no quotes
        `"${hasReceipt ? 'Yes' : 'No'}"`, // Receipt Attached - quoted
        `"${description}"`,
      ].join(','));
    });

    lines.push('');

    // Totals
    const total = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
    const currency = report.currency || expenses[0]?.currency || 'INR';
    lines.push('TOTALS');
    lines.push(`Subtotal,"${currency}",${total.toFixed(2)}`);
    lines.push('');

    // Footer
    lines.push('FOOTER');
    lines.push('"Don\'t forget to attach the receipts"');
    lines.push('');
    lines.push('Employee Signature:');
    lines.push('');
    lines.push(`Date of Submission,${formatDate(report.submittedAt || report.updatedAt || new Date())}`);

    // Add UTF-8 BOM for Excel compatibility
    const csvContent = lines.join('\r\n');
    const utf8Bom = '\uFEFF';
    return Buffer.from(utf8Bom + csvContent, 'utf-8');
  }
}


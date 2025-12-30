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

    // Get company settings for first report (assuming same company)
    let companySettings = null;
    if (reports.length > 0 && reports[0].userId) {
      const user = reports[0].userId as any;
      if (user.companyId) {
        companySettings = await CompanySettings.findOne({ companyId: user.companyId }).exec();
      }
    }

    const lines: string[] = [];

    // CSV Header
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

    // Process each report
    for (const report of reports) {
      const expenses = await Expense.find({ reportId: report._id })
        .populate('categoryId', 'name')
        .sort({ expenseDate: 1 })
        .exec();

      const fyConfig = companySettings?.financialYear || {
        startMonth: 4,
        startDay: 1,
        endMonth: 3,
        endDay: 31,
      };

      const reportDate = new Date(report.fromDate);
      const fy = getFinancialYear(reportDate, fyConfig);

      const costCentre = report.costCentreId as any;
      const project = report.projectId as any;
      const user = report.userId as any;

      expenses.forEach((exp) => {
        const expenseDate = new Date(exp.expenseDate);
        const invoiceDate = exp.invoiceDate ? new Date(exp.invoiceDate).toISOString().split('T')[0] : '';
        
        const row = [
          fy.year,
          (report._id as mongoose.Types.ObjectId).toString(),
          `"${(report.name || '').replace(/"/g, '""')}"`,
          `"${((user?.name || '') || '').replace(/"/g, '""')}"`,
          user?.email || '',
          costCentre?.code || '',
          `"${(costCentre?.name || '').replace(/"/g, '""')}"`,
          project?.code || '',
          `"${(project?.name || '').replace(/"/g, '""')}"`,
          expenseDate.toISOString().split('T')[0],
          exp.invoiceId || '',
          invoiceDate,
          `"${(exp.vendor || '').replace(/"/g, '""')}"`,
          `"${((exp.categoryId as any)?.name || 'N/A').replace(/"/g, '""')}"`,
          exp.amount.toString(),
          exp.currency || 'INR',
          `"${((exp.notes || '').replace(/"/g, '""')).replace(/,/g, ';')}"`,
          report.status,
          report.submittedAt ? new Date(report.submittedAt).toISOString().split('T')[0] : '',
          report.approvedAt ? new Date(report.approvedAt).toISOString().split('T')[0] : '',
        ];
        lines.push(row.join(','));
      });
    }

    return Buffer.from(lines.join('\n'), 'utf-8');
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
}


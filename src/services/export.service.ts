import { ExpenseReport } from '../models/ExpenseReport';
import { Expense } from '../models/Expense';
import { ExportFormat } from '../utils/enums';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, getS3Bucket } from '../config/aws';
import { getObjectUrl } from '../utils/s3';
import { randomUUID } from 'crypto';
// import { logger } from '../utils/logger'; // Unused

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
        buffer = await this.generateCSV(report as any, expenses);
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
    expensesSheet.addRow(['Date', 'Vendor', 'Category', 'Amount', 'Currency', 'Notes']);

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
      expensesSheet.addRow([
        exp.expenseDate,
        exp.vendor,
        exp.categoryId?.name || 'N/A',
        exp.amount,
        exp.currency,
        exp.notes || '',
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

  private static async generateCSV(report: any, expenses: any[]): Promise<Buffer> {
    const lines: string[] = [];

    // Header
    lines.push('Expense Report: ' + report.name);
    lines.push('');
    lines.push('Date,Vendor,Category,Amount,Currency,Notes');

    // Expenses
    expenses.forEach((exp) => {
      const row = [
        exp.expenseDate.toISOString().split('T')[0],
        exp.vendor,
        exp.categoryId?.name || 'N/A',
        exp.amount.toString(),
        exp.currency,
        (exp.notes || '').replace(/,/g, ';'), // Replace commas in notes
      ];
      lines.push(row.join(','));
    });

    return Buffer.from(lines.join('\n'), 'utf-8');
  }

  private static async generatePDF(report: any, expenses: any[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(20).text('Expense Report', { align: 'center' });
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
      doc.text('Date', 50, tableTop);
      doc.text('Vendor', 150, tableTop);
      doc.text('Category', 300, tableTop);
      doc.text('Amount', 450, tableTop);
      doc.text('Notes', 550, tableTop);

      let y = tableTop + 20;
      expenses.forEach((exp) => {
        if (y > 700) {
          doc.addPage();
          y = 50;
        }
        doc.text(exp.expenseDate.toISOString().split('T')[0], 50, y);
        doc.text(exp.vendor.substring(0, 30), 150, y);
        doc.text((exp.categoryId?.name || 'N/A').substring(0, 20), 300, y);
        doc.text(`${exp.currency} ${exp.amount}`, 450, y);
        doc.text((exp.notes || '').substring(0, 30), 550, y);
        y += 20;
      });

      doc.end();
    });
  }
}


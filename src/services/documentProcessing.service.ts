import { GetObjectCommand } from '@aws-sdk/client-s3';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { Readable } from 'stream';

import { s3Client, getS3Bucket } from '../config/aws';
import { config } from '../config/index';
import { togetherAIClient, getVisionModel } from '../config/openai';
import { Category } from '../models/Category';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { ExpenseStatus } from '../utils/enums';

import { ReportsService } from './reports.service';

import { logger } from '@/config/logger';

// PDF parse result interface
interface PdfParseResult {
  numpages: number;
  numrender: number;
  info: Record<string, unknown>;
  metadata: Record<string, unknown>;
  text: string;
  version: string;
}

export interface ExtractedReceipt {
  vendor?: string;
  date?: string;
  totalAmount?: number;
  currency?: string;
  tax?: number;
  categorySuggestion?: string;
  lineItems?: Array<{ description: string; amount: number }>;
  notes?: string;
  confidence?: number;
  pageNumber?: number;
  sourceType?: 'pdf' | 'excel' | 'image';
}

export interface DocumentProcessingResult {
  success: boolean;
  receipts: ExtractedReceipt[];
  expensesCreated: string[];
  errors: string[];
  documentType: 'pdf' | 'excel' | 'image';
  totalPages?: number;
}

export class DocumentProcessingService {
  /**
   * Process a document (PDF, Excel, or image) and extract receipts
   */
  static async processDocument(
    storageKey: string,
    mimeType: string,
    reportId: string,
    userId: string,
    documentReceiptId?: string // Receipt ID of the uploaded document
  ): Promise<DocumentProcessingResult> {
    logger.info({ storageKey, mimeType, reportId, documentReceiptId }, 'Processing document');

    // Verify report exists and belongs to user
    const report = await ExpenseReport.findById(reportId);
    if (!report) {
      throw new Error('Report not found');
    }
    if (report.userId.toString() !== userId) {
      throw new Error('Access denied');
    }
    if (report.status !== 'DRAFT') {
      throw new Error('Can only add expenses to draft reports');
    }

    const bucket = getS3Bucket('receipts');
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: storageKey,
    });

    const response = await s3Client.send(command);
    if (!response.Body) {
      throw new Error('S3 object has no body content');
    }

    const buffer = await this.streamToBuffer(response.Body);

    // Determine document type and process accordingly
    if (mimeType === 'application/pdf') {
      return await this.processPdf(buffer, storageKey, reportId, userId, documentReceiptId);
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel' ||
      mimeType === 'text/csv'
    ) {
      return await this.processExcel(buffer, reportId, userId, mimeType, documentReceiptId);
    } else if (mimeType.startsWith('image/')) {
      return await this.processImage(buffer, mimeType, storageKey, reportId, userId, documentReceiptId);
    } else {
      throw new Error(`Unsupported document type: ${mimeType}`);
    }
  }

  /**
   * Process a PDF document - extract each page as image and run OCR
   */
  private static async processPdf(
    buffer: Buffer,
    storageKey: string,
    reportId: string,
    userId: string,
    documentReceiptId?: string
  ): Promise<DocumentProcessingResult> {
    logger.info({ storageKey, documentReceiptId }, 'Processing PDF document');

    const result: DocumentProcessingResult = {
      success: true,
      receipts: [],
      expensesCreated: [],
      errors: [],
      documentType: 'pdf',
    };

    try {
      // First, parse PDF to get basic info and text content
      // Import PDFParse class from pdf-parse v2
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      const textResult = await parser.getText();
      const pdfData: PdfParseResult = {
        numpages: textResult.pages?.length || 1,
        numrender: textResult.pages?.length || 1,
        info: {},
        metadata: {},
        text: textResult.text || '',
        version: '2.0',
      };
      result.totalPages = pdfData.numpages;

      logger.info({ 
        pages: pdfData.numpages, 
        textLength: pdfData.text.length 
      }, 'PDF parsed successfully');

      // For multi-receipt PDFs, we use AI to analyze the entire PDF
      // and identify individual receipts
      const receipts = await this.extractReceiptsFromPdfWithAI(buffer, pdfData);
      
      result.receipts = receipts;

      // Create expense drafts for each extracted receipt
      for (let i = 0; i < receipts.length; i++) {
        const receipt = receipts[i];
        try {
          const expenseId = await this.createExpenseDraft(
            receipt,
            reportId,
            userId,
            documentReceiptId, // Pass document receipt ID for linking
            'pdf', // Source document type
            i + 1 // Sequence number (1-indexed)
          );
          result.expensesCreated.push(expenseId);
        } catch (error: any) {
          logger.error({ error: error.message, receipt }, 'Failed to create expense draft');
          result.errors.push(`Failed to create expense for receipt: ${error.message}`);
        }
      }

      if (result.expensesCreated.length === 0 && result.receipts.length === 0) {
        result.success = false;
        result.errors.push('No receipts could be extracted from the PDF');
      }

    } catch (error: any) {
      logger.error({ error: error.message, storageKey }, 'PDF processing failed');
      result.success = false;
      result.errors.push(`PDF processing failed: ${error.message}`);
    }

    return result;
  }

  /**
   * Extract receipts from PDF using AI vision
   * Converts PDF pages to images first since vision models don't accept PDFs directly
   */
  private static async extractReceiptsFromPdfWithAI(
    buffer: Buffer,
    pdfData: PdfParseResult
  ): Promise<ExtractedReceipt[]> {
    // If OCR is disabled, return empty
    if (config.ocr.disableOcr) {
      logger.info('OCR disabled, skipping PDF analysis');
      return [];
    }

    const model = getVisionModel();
    const allReceipts: ExtractedReceipt[] = [];

    try {
      // Convert PDF pages to images using pdf-to-img
      // Vision models only accept images, not PDFs directly
      const { pdf } = await import('pdf-to-img');
      const pdfDocument = await pdf(buffer, { scale: 2 }); // scale 2 for better quality

      let pageNumber = 0;
      for await (const pageImage of pdfDocument) {
        pageNumber++;
        
        logger.info({ pageNumber, totalPages: pdfData.numpages }, 'Processing PDF page as image');

        try {
          // Convert page image buffer to base64
          const base64Image = Buffer.from(pageImage).toString('base64');

          const prompt = `You are an expense receipt extraction system. Analyze this image which is a page from a PDF document.

This page may contain ONE OR MULTIPLE expense receipts. Extract ALL receipts visible in this image.

For EACH receipt you find, extract the following:
- vendor: merchant/store name
- date: transaction date in ISO format YYYY-MM-DD
- totalAmount: total amount as a number
- currency: currency code (INR, USD, EUR, etc.)
- tax: tax amount if visible
- categorySuggestion: one of (Travel, Food, Office, Others)
- lineItems: array of items with description and amount
- notes: any additional notes

Return a JSON object with this structure:
{
  "receipts": [
    {
      "vendor": "Store Name",
      "date": "2024-01-15",
      "totalAmount": 1234.56,
      "currency": "INR",
      "categorySuggestion": "Food",
      "lineItems": [{"description": "Item 1", "amount": 500}],
      "notes": "Additional info"
    }
  ]
}

If you find multiple receipts on this page, include ALL of them.
If this page doesn't contain any valid receipts, return: {"receipts": []}

IMPORTANT: Return ONLY valid JSON. No markdown, no explanations.`;

          const response = await togetherAIClient.chat.completions.create({
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/png;base64,${base64Image}`,
                      detail: 'high',
                    },
                  },
                ],
              },
            ],
            max_tokens: 2000,
            response_format: { type: 'json_object' },
            temperature: 0.1,
          });

          const content = response.choices[0]?.message?.content;
          if (content) {
            let cleanedContent = content.trim();
            if (cleanedContent.startsWith('```json')) {
              cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
            } else if (cleanedContent.startsWith('```')) {
              cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
            }

            const parsed = JSON.parse(cleanedContent);
            const pageReceipts: ExtractedReceipt[] = (parsed.receipts || []).map((r: any) => ({
              ...r,
              sourceType: 'pdf' as const,
              pageNumber,
              confidence: 0.85,
            }));

            allReceipts.push(...pageReceipts);
            logger.info({ pageNumber, receiptsFound: pageReceipts.length }, 'Page processed successfully');
          }
        } catch (pageError: any) {
          logger.error({ pageNumber, error: pageError.message }, 'Failed to process page');
          // Continue processing other pages
        }
      }

      logger.info({ totalReceipts: allReceipts.length, totalPages: pageNumber }, 'PDF processing completed');
      return allReceipts;
    } catch (error: any) {
      logger.error({ error: error.message }, 'AI PDF extraction failed, falling back to text analysis');
      // Fallback: Try to extract from text content
      return this.extractReceiptsFromText(pdfData.text);
    }
  }

  /**
   * Fallback: Extract receipts from text content when AI fails
   */
  private static extractReceiptsFromText(text: string): ExtractedReceipt[] {
    const receipts: ExtractedReceipt[] = [];
    
    // Split text by common receipt separators
    const sections = text.split(/(?:page|---+|={3,}|\n{3,})/i);
    
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i].trim();
      if (section.length < 50) continue; // Skip very short sections
      
      const receipt = this.parseReceiptFromText(section);
      if (receipt && (receipt.vendor || receipt.totalAmount)) {
        receipt.pageNumber = i + 1;
        receipt.sourceType = 'pdf';
        receipts.push(receipt);
      }
    }
    
    return receipts;
  }

  /**
   * Parse a single receipt from text
   */
  private static parseReceiptFromText(text: string): ExtractedReceipt | null {
    const receipt: ExtractedReceipt = {};

    // Try to extract vendor (usually first line or after specific keywords)
    const vendorPatterns = [
      /(?:^|store|merchant|vendor|from)[:\s]+([^\n,]+)/im,
      /^([A-Z][A-Za-z\s]+(?:Inc|LLC|Ltd|Corp)?)/m,
    ];
    for (const pattern of vendorPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        receipt.vendor = match[1].trim().substring(0, 100);
        break;
      }
    }

    // Try to extract amount
    const amountPatterns = [
      /total[:\s]*(?:₹|\$|€|£)?[\s]*([\d,]+\.?\d*)/i,
      /amount[:\s]*(?:₹|\$|€|£)?[\s]*([\d,]+\.?\d*)/i,
      /(?:₹|\$|€|£)\s*([\d,]+\.?\d*)/,
      /([\d,]+\.\d{2})/,
    ];
    for (const pattern of amountPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const amount = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(amount) && amount > 0) {
          receipt.totalAmount = amount;
          break;
        }
      }
    }

    // Try to extract date
    const datePatterns = [
      /date[:\s]*(\d{4}-\d{2}-\d{2})/i,
      /(\d{2}[/-]\d{2}[/-]\d{4})/,
      /(\d{4}[/-]\d{2}[/-]\d{2})/,
    ];
    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        receipt.date = match[1];
        break;
      }
    }

    // Try to extract currency
    if (text.includes('₹') || text.toLowerCase().includes('inr')) {
      receipt.currency = 'INR';
    } else if (text.includes('$') || text.toLowerCase().includes('usd')) {
      receipt.currency = 'USD';
    } else if (text.includes('€') || text.toLowerCase().includes('eur')) {
      receipt.currency = 'EUR';
    }

    // Try to suggest category based on keywords
    const categoryKeywords = {
      Travel: ['flight', 'hotel', 'taxi', 'uber', 'train', 'airport', 'airfare', 'booking'],
      Food: ['restaurant', 'cafe', 'food', 'meal', 'lunch', 'dinner', 'breakfast', 'coffee'],
      Office: ['office', 'supplies', 'stationery', 'printer', 'computer', 'software'],
    };

    const lowerText = text.toLowerCase();
    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some(keyword => lowerText.includes(keyword))) {
        receipt.categorySuggestion = category;
        break;
      }
    }

    if (!receipt.categorySuggestion) {
      receipt.categorySuggestion = 'Others';
    }

    receipt.confidence = 0.6;
    return receipt;
  }

  /**
   * Process an Excel file - extract expense data from rows
   */
  private static async processExcel(
    buffer: Buffer,
    reportId: string,
    userId: string,
    mimeType: string,
    documentReceiptId?: string
  ): Promise<DocumentProcessingResult> {
    logger.info({ mimeType, reportId, documentReceiptId }, 'Processing Excel document');

    const result: DocumentProcessingResult = {
      success: true,
      receipts: [],
      expensesCreated: [],
      errors: [],
      documentType: 'excel',
    };

    try {
      const workbook = new ExcelJS.Workbook();
      
      if (mimeType === 'text/csv') {
        // For CSV, create a readable stream from buffer
        const stream = Readable.from(buffer);
        await workbook.csv.read(stream);
      } else {
        // For Excel, use the buffer directly with type assertion
        // ExcelJS accepts Buffer but TypeScript definition expects ArrayBuffer
        await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      }

      // Get the first worksheet
      const worksheet = workbook.worksheets[0];
      if (!worksheet) {
        throw new Error('No worksheet found in Excel file');
      }

      // Get headers from first row
      const headers: { [key: string]: number } = {};
      const headerRow = worksheet.getRow(1);
      headerRow.eachCell((cell, colNumber) => {
        const value = cell.value?.toString().toLowerCase().trim() || '';
        headers[value] = colNumber;
      });

      logger.info({ headers: Object.keys(headers) }, 'Excel headers detected');

      // Map common header variations
      const columnMappings = {
        vendor: ['vendor', 'merchant', 'store', 'supplier', 'name', 'description'],
        amount: ['amount', 'total', 'price', 'cost', 'value', 'sum'],
        date: ['date', 'expense date', 'transaction date', 'purchase date'],
        category: ['category', 'type', 'expense type', 'expense category'],
        currency: ['currency', 'curr'],
        notes: ['notes', 'description', 'memo', 'comments', 'remarks'],
      };

      const getColumn = (mappingKey: string): number | null => {
        const variations = columnMappings[mappingKey as keyof typeof columnMappings] || [];
        for (const variation of variations) {
          if (headers[variation] !== undefined) {
            return headers[variation];
          }
        }
        return null;
      };

      const vendorCol = getColumn('vendor');
      const amountCol = getColumn('amount');
      const dateCol = getColumn('date');
      const categoryCol = getColumn('category');
      const currencyCol = getColumn('currency');
      const notesCol = getColumn('notes');

      if (!vendorCol && !amountCol) {
        throw new Error('Could not identify vendor or amount columns. Please ensure headers include "vendor" or "merchant" and "amount" or "total".');
      }

      // Process each data row (skip header)
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header row

        try {
          const receipt: ExtractedReceipt = {
            sourceType: 'excel',
            confidence: 0.95,
          };

          if (vendorCol) {
            const vendorValue = row.getCell(vendorCol).value;
            receipt.vendor = vendorValue?.toString().trim() || undefined;
          }

          if (amountCol) {
            const amountValue = row.getCell(amountCol).value;
            const amount = typeof amountValue === 'number' 
              ? amountValue 
              : parseFloat(String(amountValue).replace(/[^0-9.-]/g, ''));
            if (!isNaN(amount) && amount > 0) {
              receipt.totalAmount = amount;
            }
          }

          if (dateCol) {
            const dateValue = row.getCell(dateCol).value;
            if (dateValue instanceof Date) {
              receipt.date = dateValue.toISOString().split('T')[0];
            } else if (typeof dateValue === 'string') {
              receipt.date = dateValue;
            }
          }

          if (categoryCol) {
            const categoryValue = row.getCell(categoryCol).value;
            receipt.categorySuggestion = categoryValue?.toString().trim() || 'Others';
          }

          if (currencyCol) {
            const currencyValue = row.getCell(currencyCol).value;
            receipt.currency = currencyValue?.toString().trim().toUpperCase() || 'INR';
          } else {
            receipt.currency = 'INR';
          }

          if (notesCol) {
            const notesValue = row.getCell(notesCol).value;
            receipt.notes = notesValue?.toString().trim() || undefined;
          }

          // Only add if we have meaningful data
          if (receipt.vendor || receipt.totalAmount) {
            result.receipts.push(receipt);
          }
        } catch (rowError: any) {
          logger.warn({ rowNumber, error: rowError.message }, 'Failed to parse row');
          result.errors.push(`Row ${rowNumber}: ${rowError.message}`);
        }
      });

      result.totalPages = result.receipts.length;
      logger.info({ receiptCount: result.receipts.length }, 'Extracted receipts from Excel');

      // Create expense drafts for each extracted receipt
      for (let i = 0; i < result.receipts.length; i++) {
        const receipt = result.receipts[i];
        try {
          const expenseId = await this.createExpenseDraft(
            receipt,
            reportId,
            userId,
            documentReceiptId, // Link Excel document to expenses
            'excel', // Source document type
            i + 1 // Row number (1-indexed, excluding header)
          );
          result.expensesCreated.push(expenseId);
        } catch (error: any) {
          logger.error({ error: error.message, receipt }, 'Failed to create expense draft from Excel');
          result.errors.push(`Failed to create expense: ${error.message}`);
        }
      }

      if (result.expensesCreated.length === 0 && result.receipts.length === 0) {
        result.success = false;
        result.errors.push('No expense data could be extracted from the Excel file');
      }

    } catch (error: any) {
      logger.error({ error: error.message }, 'Excel processing failed');
      result.success = false;
      result.errors.push(`Excel processing failed: ${error.message}`);
    }

    return result;
  }

  /**
   * Process an image file - single receipt OCR
   */
  private static async processImage(
    buffer: Buffer,
    mimeType: string,
    storageKey: string,
    reportId: string,
    userId: string,
    documentReceiptId?: string
  ): Promise<DocumentProcessingResult> {
    logger.info({ storageKey, mimeType, documentReceiptId }, 'Processing image document');

    const result: DocumentProcessingResult = {
      success: true,
      receipts: [],
      expensesCreated: [],
      errors: [],
      documentType: 'image',
      totalPages: 1,
    };

    if (config.ocr.disableOcr) {
      logger.info('OCR disabled');
      return result;
    }

    try {
      // Optimize image if needed
      let processedBuffer = buffer;
      try {
        processedBuffer = await sharp(buffer)
          .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch {
        logger.warn('Sharp processing failed, using original buffer');
      }

      const base64Image = processedBuffer.toString('base64');
      const model = getVisionModel();

      const prompt = `You are a receipt OCR system. Extract all information from this receipt image.
If this image contains MULTIPLE receipts, extract ALL of them.

For EACH receipt found, extract:
- vendor: merchant/store name
- date: transaction date in ISO format YYYY-MM-DD
- totalAmount: total amount as a number
- currency: currency code (INR, USD, EUR, etc.)
- tax: tax amount if visible
- categorySuggestion: one of (Travel, Food, Office, Others)
- lineItems: array of items with description and amount
- notes: any additional notes

Return a JSON object:
{
  "receipts": [
    {
      "vendor": "Store Name",
      "date": "2024-01-15",
      "totalAmount": 1234.56,
      "currency": "INR",
      "categorySuggestion": "Food",
      "lineItems": [{"description": "Item 1", "amount": 500}],
      "notes": "Additional info"
    }
  ]
}

IMPORTANT: Return ONLY valid JSON.`;

      const response = await togetherAIClient.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from AI');
      }

      let cleanedContent = content.trim();
      if (cleanedContent.startsWith('```json')) {
        cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedContent.startsWith('```')) {
        cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(cleanedContent);
      const receipts: ExtractedReceipt[] = (parsed.receipts || []).map((r: any) => ({
        ...r,
        sourceType: 'image' as const,
        confidence: 0.85,
      }));

      result.receipts = receipts;
      result.totalPages = receipts.length;

      // Create expense drafts
      for (let i = 0; i < receipts.length; i++) {
        const receipt = receipts[i];
        try {
          const expenseId = await this.createExpenseDraft(
            receipt,
            reportId,
            userId,
            documentReceiptId, // Link image document to expenses
            'image', // Source document type
            i + 1 // Sequence number (1-indexed)
          );
          result.expensesCreated.push(expenseId);
        } catch (error: any) {
          logger.error({ error: error.message }, 'Failed to create expense draft from image');
          result.errors.push(`Failed to create expense: ${error.message}`);
        }
      }

    } catch (error: any) {
      logger.error({ error: error.message }, 'Image processing failed');
      result.success = false;
      result.errors.push(`Image processing failed: ${error.message}`);
    }

    return result;
  }

  /**
   * Create an expense draft from extracted receipt data
   * Links the source document as a receipt to the expense
   */
  private static async createExpenseDraft(
    receipt: ExtractedReceipt,
    reportId: string,
    userId: string,
    documentReceiptId?: string, // Receipt ID of the source PDF/Excel/image
    sourceDocumentType?: 'pdf' | 'excel' | 'image',
    sourceDocumentSequence?: number // Receipt number in the source document
  ): Promise<string> {
    // Try to find matching category
    let categoryId: mongoose.Types.ObjectId | undefined;
    if (receipt.categorySuggestion) {
      const category = await Category.findOne({
        name: { $regex: new RegExp(`^${receipt.categorySuggestion}$`, 'i') }
      });
      if (category) {
        categoryId = category._id as mongoose.Types.ObjectId;
      }
    }

    // If no category matched, try to get a default one
    if (!categoryId) {
      const defaultCategory = await Category.findOne({ name: 'Others' }) || 
                              await Category.findOne({});
      if (defaultCategory) {
        categoryId = defaultCategory._id as mongoose.Types.ObjectId;
      }
    }

    // Prepare receipt IDs array - link to source document if provided
    const receiptIds: mongoose.Types.ObjectId[] = [];
    if (documentReceiptId) {
      receiptIds.push(new mongoose.Types.ObjectId(documentReceiptId));
    }

    const expense = new Expense({
      reportId: new mongoose.Types.ObjectId(reportId),
      userId: new mongoose.Types.ObjectId(userId),
      vendor: receipt.vendor || 'Receipt Processing...',
      categoryId,
      amount: receipt.totalAmount || 0,
      currency: receipt.currency || 'INR',
      expenseDate: receipt.date ? new Date(receipt.date) : new Date(),
      status: ExpenseStatus.DRAFT,
      source: receipt.sourceType === 'excel' ? 'MANUAL' : 'SCANNED',
      notes: receipt.notes || (receipt.lineItems 
        ? receipt.lineItems.map(item => `${item.description}: ${item.amount}`).join('\n')
        : undefined),
      receiptIds,
      receiptPrimaryId: documentReceiptId ? new mongoose.Types.ObjectId(documentReceiptId) : undefined,
      // Bulk upload tracking
      sourceDocumentType,
      sourceDocumentSequence,
    });

    const saved = await expense.save();

    // Recalculate report totals
    await ReportsService.recalcTotals(reportId);

    logger.info({
      expenseId: saved._id,
      vendor: receipt.vendor,
      amount: receipt.totalAmount,
    }, 'Expense draft created from extracted receipt');

    return (saved._id as mongoose.Types.ObjectId).toString();
  }

  /**
   * Helper to convert stream to buffer
   */
  private static async streamToBuffer(stream: any): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  /**
   * Get supported mime types
   */
  static getSupportedMimeTypes(): string[] {
    return [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
    ];
  }

  /**
   * Check if a mime type is supported
   */
  static isSupportedMimeType(mimeType: string): boolean {
    return this.getSupportedMimeTypes().includes(mimeType) || mimeType.startsWith('image/');
  }
}


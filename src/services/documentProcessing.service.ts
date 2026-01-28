import { Readable } from 'stream';

import { GetObjectCommand } from '@aws-sdk/client-s3';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import sharp from 'sharp';

import { s3Client, getS3Bucket } from '../config/aws';
import { config } from '../config/index';
import { openaiClient } from '../config/openai';
import { Category } from '../models/Category';
import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';
import { ExpenseStatus } from '../utils/enums';

import { ReportsService } from './reports.service';
import {
  buildFullReceiptText,
  inferCategoryFromReceiptText,
  extractNotesFromLineItems,
} from './ocr/ocrPostProcess.service';

import { logger } from '@/config/logger';
import { DateUtils } from '@/utils/dateUtils';

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
  date?: string | Date; // Allow both string and Date for flexibility
  invoiceId?: string;
  totalAmount?: number;
  currency?: string;
  tax?: number;
  categorySuggestion?: string;
  /** Set when category was inferred from keywords; used for expense draft creation */
  categoryId?: mongoose.Types.ObjectId;
  /** True when no category could be confidently identified; app shows "Unable to identify the category. Please enter manually." */
  categoryUnidentified?: boolean;
  lineItems?: Array<{ description: string; amount: number }>;
  notes?: string;
  confidence?: number;
  pageNumber?: number;
  sourceType?: 'pdf' | 'excel' | 'image';
}

export interface DocumentProcessingResult {
  success: boolean;
  receipts: ExtractedReceipt[];
  // Keep index alignment with receipts: each element is the created expenseId OR null (duplicate/error)
  expensesCreated: Array<string | null>;
  // Optional detailed per-receipt outcome for richer UIs (backwards compatible)
  results?: Array<{
    index: number;
    status: 'created' | 'duplicate' | 'error' | 'extracted';
    expenseId?: string | null;
    duplicateExpense?: any;
    message?: string;
  }>;
  errors: string[];
  documentType: 'pdf' | 'excel' | 'image';
  totalPages?: number;
}

export class DocumentProcessingService {
  // OCR concurrency semaphore - limit to max 2 concurrent OCR calls
  private static ocrSemaphore = { count: 0, max: 2 };
  
  private static async acquireOcrSlot(): Promise<void> {
    while (this.ocrSemaphore.count >= this.ocrSemaphore.max) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.ocrSemaphore.count++;
  }
  
  private static releaseOcrSlot(): void {
    this.ocrSemaphore.count--;
  }

  private static normalizeAiReceipt(raw: any): ExtractedReceipt {
    // Extract invoice ID from multiple possible fields including UPI Reference, Transaction ID, etc.
    const invoiceId =
      raw?.invoiceId ??
      raw?.invoice_number ??
      raw?.invoice_id ??
      raw?.invoiceNo ??
      raw?.invoice_no ??
      raw?.billNo ??
      raw?.bill_no ??
      raw?.receiptNo ??
      raw?.receipt_no ??
      raw?.upi_ref_no ??
      raw?.upi_reference_number ??
      raw?.upiRefNo ??
      raw?.transaction_id ??
      raw?.transactionId ??
      raw?.txn_id ??
      raw?.payment_reference ??
      raw?.paymentReference ??
      raw?.payment_id ??
      raw?.paymentId ??
      raw?.order_id ??
      raw?.orderId;

    const date = raw?.date ?? raw?.invoiceDate ?? raw?.invoice_date;
    
    // Build notes from lineItems as comma-separated item descriptions (not "desc: amt")
    let notes = raw?.notes;
    if (!notes && raw?.lineItems && Array.isArray(raw.lineItems) && raw.lineItems.length > 0) {
      const descriptions = raw.lineItems
        .map((item: any) => (item.description || item.desc || '').toString().trim())
        .filter((d: string) => d.length > 0);
      notes = descriptions.length > 0 ? descriptions.join(', ') : undefined;
    }

    return {
      ...raw,
      invoiceId: invoiceId != null ? String(invoiceId).trim() : undefined,
      date: date != null ? String(date).trim() : raw?.date,
      notes: notes || undefined,
    };
  }

  /**
   * Apply OCR post-processing to extracted receipts: category inference and notes from line items.
   * Mutates each receipt with categorySuggestion, categoryId, categoryUnidentified, and notes.
   */
  private static async applyOcrPostProcessToReceipts(
    receipts: ExtractedReceipt[],
    companyId?: mongoose.Types.ObjectId
  ): Promise<void> {
    for (const receipt of receipts) {
      const fullText = buildFullReceiptText(receipt);
      const categoryResult = await inferCategoryFromReceiptText(fullText, companyId, {
        vendorText: receipt.vendor ?? undefined,
      });
      receipt.categorySuggestion = categoryResult.categorySuggestion ?? undefined;
      receipt.categoryId = categoryResult.categoryId;
      receipt.categoryUnidentified = categoryResult.categoryUnidentified;
      const postNotes = extractNotesFromLineItems(receipt, {
        vendor: receipt.vendor,
        categoryName: categoryResult.categorySuggestion ?? undefined,
      });
      if (postNotes) {
        receipt.notes = postNotes;
      }
    }
  }
  /**
   * Process a document (PDF, Excel, or image) and extract receipts
   */
  static async processDocument(
    storageKey: string,
    mimeType: string,
    reportId: string,
    userId: string,
    documentReceiptId?: string, // Receipt ID of the uploaded document
    skipExpenseCreation: boolean = false // Skip auto-creating expense drafts
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
    // Allow adding expenses if report is DRAFT or CHANGES_REQUESTED
    if (report.status !== 'DRAFT' && report.status !== 'CHANGES_REQUESTED') {
      throw new Error('Can only add expenses to draft reports or reports with changes requested');
    }

    const user = await User.findById(userId).select('companyId').exec();
    const companyId = user?.companyId as mongoose.Types.ObjectId | undefined;

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
      return await this.processPdf(buffer, storageKey, reportId, userId, documentReceiptId, companyId, skipExpenseCreation);
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel' ||
      mimeType === 'text/csv'
    ) {
      return await this.processExcel(buffer, reportId, userId, mimeType, documentReceiptId, companyId, skipExpenseCreation);
    } else if (mimeType.startsWith('image/')) {
      return await this.processImage(buffer, mimeType, storageKey, reportId, userId, documentReceiptId, companyId, skipExpenseCreation);
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
    documentReceiptId?: string,
    companyId?: mongoose.Types.ObjectId,
    skipExpenseCreation: boolean = false
  ): Promise<DocumentProcessingResult> {
    logger.info({ storageKey, documentReceiptId }, 'Processing PDF document');

    const result: DocumentProcessingResult = {
      success: true,
      receipts: [],
      expensesCreated: [],
      results: [],
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
      const receipts = await this.extractReceiptsFromPdfWithAI(buffer, pdfData, storageKey);

      result.receipts = receipts;
      await this.applyOcrPostProcessToReceipts(result.receipts, companyId);

      // Create expense drafts for each extracted receipt. Duplicate detection is flag-only (no skip).
      for (let i = 0; i < receipts.length; i++) {
        const receipt = receipts[i];
        try {
          if (!skipExpenseCreation) {
            const expenseId = await this.createExpenseDraft(
              receipt,
              reportId,
              userId,
              documentReceiptId, // Pass document receipt ID for linking
              'pdf', // Source document type
              i + 1 // Sequence number (1-indexed)
            );
            result.expensesCreated.push(expenseId);
            // Flag-only duplicate check: updates expense.duplicateFlag/duplicateReason; never blocks
            let duplicateFlag: string | null = null;
            let duplicateReason: string | null = null;
            try {
              const { DuplicateDetectionService } = await import('./duplicateDetection.service');
              const dr = await DuplicateDetectionService.runDuplicateCheck(expenseId, companyId);
              duplicateFlag = dr.duplicateFlag;
              duplicateReason = dr.duplicateReason;
            } catch (_) { /* non-blocking */ }
            result.results?.push({
              index: i,
              status: 'created',
              expenseId,
              ...(duplicateFlag && duplicateReason ? { duplicateFlag, duplicateReason } : {}),
            });
          } else {
              // Skip expense creation - user will create expenses manually
              result.expensesCreated.push(null);
              result.results?.push({ index: i, status: 'extracted', expenseId: null });
            }
        } catch (error: any) {
          logger.error({ error: error.message, receipt }, 'Failed to create expense draft');
          result.errors.push(`Failed to create expense for receipt: ${error.message}`);
          // Keep index alignment
          result.expensesCreated.push(null);
          result.results?.push({ index: i, status: 'error', message: error.message });
        }
      }

      if (result.expensesCreated.length === 0 && result.receipts.length === 0) {
        result.success = false;
        result.errors.push('No receipts could be extracted from the PDF');
      }

    } catch (error: any) {
      // Non-OCR errors (S3, PDF parsing, etc.) - log but don't fail completely
      if (config.ocr.demoMode) {
        // Demo mode: silently ignore all errors
        result.receipts = [];
        result.totalPages = 0;
        return result;
      }
      
      // If we have receipts extracted, don't mark as completely failed
      // Only mark as failed if no receipts were extracted
      if (result.receipts.length === 0 && result.expensesCreated.length === 0) {
        result.success = false;
        result.errors.push(`PDF processing failed: ${error.message}`);
      } else {
        // Partial success - receipts extracted but some errors occurred
        result.errors.push(`Some errors occurred during processing: ${error.message}`);
      }
    }

    return result;
  }

  /**
   * Extract receipts from PDF using AI vision
   * Converts PDF pages to images first since vision models don't accept PDFs directly
   */
  private static async extractReceiptsFromPdfWithAI(
    buffer: Buffer,
    pdfData: PdfParseResult,
    storageKey?: string
  ): Promise<ExtractedReceipt[]> {
    // If OCR is disabled, return empty
    if (config.ocr.disableOcr) {
      logger.info('OCR disabled, skipping PDF analysis');
      return [];
    }

    const allReceipts: ExtractedReceipt[] = [];

    try {
      // Convert PDF pages to images using pdf-to-img
      // Vision models only accept images, not PDFs directly
      const { pdf } = await import('pdf-to-img');
      const pdfDocument = await pdf(buffer, { scale: 2 }); // scale 2 for better quality

      let pageNumber = 0;
      for await (const pageImage of pdfDocument) {
        pageNumber++;

        try {
          // Convert page image buffer to base64
          const base64Image = Buffer.from(pageImage).toString('base64');

          const prompt = `You are an OCR extraction engine.

Given an image of a receipt or invoice, extract ONLY the following fields.
If a field is not visible, return null.

Return STRICT JSON only. No explanations. No markdown.

For EACH receipt found in the image, return:
- vendor_name (string) - Extract merchant/recipient/shop name
- invoice_number (string | null) - Extract ANY of these if found:
  * Invoice ID / Invoice Number
  * UPI Ref No / UPI Reference Number / UPI Ref
  * Transaction ID / Transaction Reference / Txn ID
  * Payment Reference / Payment ID / Payment Ref
  * Bill Number / Bill No
  * Receipt Number / Receipt No
  * Order ID / Order Number
  * Any unique transaction identifier visible on the receipt
- invoice_date (ISO date string YYYY-MM-DD | null)
- total_amount (number | null) - Extract as number without currency symbol
- currency (string | null) - Extract currency code (INR, USD, etc.)
- tax_amount (number | null)
- line_items (array of { description, amount })

Rules:
- Do NOT guess values
- Do NOT hallucinate
- Use INR if currency symbol ₹ is present
- Dates must be YYYY-MM-DD format
- For invoice_number, prioritize UPI Reference Number, Transaction ID, or Payment Reference if this is a payment receipt
- Return JSON: {"receipts": [{"vendor_name": "...", "invoice_number": "...", "invoice_date": "YYYY-MM-DD", "total_amount": number, "currency": "...", "tax_amount": number, "line_items": [{"description": "...", "amount": number}]}]}
- If multiple receipts in image, include all in receipts array
- If no receipts found, return {"receipts": []}`;

          // OCR processing with concurrency limit and error handling
          await this.acquireOcrSlot();
          try {
            let content: string;
            const primaryModel = 'gpt-4o-mini';
            const fallbackModel = 'gpt-4o';
            
            try {
              // Try primary model first
              const response = await openaiClient.chat.completions.create({
                model: primaryModel,
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
                temperature: 0.0,
              });

              content = response.choices[0]?.message?.content || '';
              if (!content) {
                continue; // Skip empty responses
              }
            } catch (ocrError: any) {
              // Check if error is retryable (not authentication, not invalid model, etc.)
              const isRetryable = !(
                ocrError.status === 401 || 
                ocrError.message?.includes('authentication') || 
                ocrError.message?.includes('Unauthorized') ||
                ocrError.message?.includes('invalid_model') ||
                ocrError.code === 'invalid_model'
              );

              if (isRetryable) {
                // Log fallback attempt
                logger.warn({ 
                  primaryModel, 
                  fallbackModel, 
                  error: ocrError.message,
                  pageNumber
                }, 'Primary OCR model failed for PDF page, attempting fallback');
                
                // Try fallback model
                try {
                  const fallbackResponse = await openaiClient.chat.completions.create({
                    model: fallbackModel,
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
                    temperature: 0.0,
                  });

                  content = fallbackResponse.choices[0]?.message?.content || '';
                  if (!content) {
                    logger.warn({ pageNumber }, 'OCR returned empty response from fallback model for PDF page');
                    continue; // Skip this page
                  }
                } catch (fallbackError: any) {
                  // Both models failed - log and skip this page
                  const errorDetails = {
                    message: fallbackError.message,
                    status: fallbackError.status,
                    code: fallbackError.code,
                    pageNumber,
                    primaryError: ocrError.message,
                  };
                  
                  // Log error details (only in non-production to avoid spam)
                  if (config.app.env !== 'production' && !config.ocr.demoMode) {
                    logger.error({ error: errorDetails }, 'Both OCR models failed for PDF page');
                  }
                  
                  // OCR failure for this page - non-blocking, skip page and continue
                  continue; // Skip this page, continue with next
                }
              } else {
                // Non-retryable error - log and skip this page
                const errorDetails = {
                  message: ocrError.message,
                  status: ocrError.status,
                  code: ocrError.code,
                  pageNumber,
                };
                
                // Log error details (only in non-production to avoid spam)
                if (config.app.env !== 'production' && !config.ocr.demoMode) {
                  logger.error({ error: errorDetails }, 'Non-retryable OCR error for PDF page');
                }
                
                // OCR failure for this page - non-blocking, skip page and continue
                continue; // Skip this page, continue with next
              }
            }
            
            // Parse OpenAI response safely
            try {
              let cleanedContent = content.trim();
              if (cleanedContent.startsWith('```json')) {
                cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              } else if (cleanedContent.startsWith('```')) {
                cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
              }

              const parsed = JSON.parse(cleanedContent);
              // Map response format to our internal format (support both vendor_name and vendor)
              const pageReceipts: ExtractedReceipt[] = (parsed.receipts || []).map((r: any) => {
                const normalized: ExtractedReceipt = {
                  vendor: r.vendor_name || r.vendor,
                  invoiceId: r.invoice_number || r.invoiceId || r.invoice_id,
                  date: r.invoice_date || r.date || r.invoiceDate,
                  totalAmount: r.total_amount || r.totalAmount,
                  currency: r.currency || 'INR',
                  tax: r.tax_amount || r.tax || r.taxAmount,
                  lineItems: r.line_items || r.lineItems,
                  sourceType: 'pdf' as const,
                  pageNumber,
                  confidence: 0.85,
                };
                return this.normalizeAiReceipt(normalized);
              });

              allReceipts.push(...pageReceipts);
            } catch (parseError: any) {
              // JSON parsing failure for this page - non-blocking, skip page and continue
              if (!config.ocr.demoMode) {
                // Only log if not in demo mode
                // Continue processing other pages
              }
              continue; // Skip this page, continue with next
            }
          } finally {
            this.releaseOcrSlot();
          }
        } catch (pageError: any) {
          // Page processing error - non-blocking, continue with other pages
          // Error already handled in inner try-catch, just continue
        }
      }

      // Only log summary if receipts were extracted or if not in demo mode
      if (allReceipts.length > 0 || !config.ocr.demoMode) {
        const fileName = storageKey ? storageKey.split('/').pop() : 'unknown';
        logger.info({ fileName, totalReceipts: allReceipts.length, totalPages: pageNumber }, 'PDF processing completed');
      }
      return allReceipts;
    } catch (error: any) {
      // PDF processing failed - return empty receipts, don't throw
      if (config.ocr.demoMode) {
        return [];
      }
      // Try fallback text extraction, but don't throw if it fails
      try {
        return this.extractReceiptsFromText(pdfData.text);
      } catch {
        return [];
      }
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

    // Try to extract invoice ID / bill number
    const invoicePatterns = [
      /(?:invoice|inv|bill|receipt)\s*(?:no|number|#)?[:\s]*([A-Z0-9][A-Z0-9\-\/]{2,})/im,
      /(?:gstin|gst)\s*(?:no|number|#)?[:\s]*([A-Z0-9]{8,})/im, // fallback identifier if present
    ];
    for (const pattern of invoicePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        receipt.invoiceId = match[1].trim().substring(0, 50);
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
    documentReceiptId?: string,
    companyId?: mongoose.Types.ObjectId,
    skipExpenseCreation: boolean = false
  ): Promise<DocumentProcessingResult> {
    logger.info({ mimeType, reportId, documentReceiptId }, 'Processing Excel document');

    const result: DocumentProcessingResult = {
      success: true,
      receipts: [],
      expensesCreated: [],
      results: [],
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
        invoiceId: ['invoice', 'invoice id', 'invoice no', 'invoice number', 'bill', 'bill no', 'bill number', 'receipt no', 'receipt number'],
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
      const invoiceIdCol = getColumn('invoiceId');
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

          if (invoiceIdCol) {
            const invValue = row.getCell(invoiceIdCol).value;
            receipt.invoiceId = invValue?.toString().trim() || undefined;
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

      // Create expense drafts for each extracted receipt. Duplicate detection is flag-only (no skip).
      for (let i = 0; i < result.receipts.length; i++) {
        const receipt = result.receipts[i];
        try {
          if (!skipExpenseCreation) {
            const expenseId = await this.createExpenseDraft(
              receipt,
              reportId,
              userId,
              documentReceiptId, // Link Excel document to expenses
              'excel', // Source document type
              i + 1 // Row number (1-indexed, excluding header)
            );
            result.expensesCreated.push(expenseId);
            let duplicateFlag: string | null = null;
            let duplicateReason: string | null = null;
            try {
              const { DuplicateDetectionService } = await import('./duplicateDetection.service');
              const dr = await DuplicateDetectionService.runDuplicateCheck(expenseId, companyId);
              duplicateFlag = dr.duplicateFlag;
              duplicateReason = dr.duplicateReason;
            } catch (_) { /* non-blocking */ }
            result.results?.push({
              index: i,
              status: 'created',
              expenseId,
              ...(duplicateFlag && duplicateReason ? { duplicateFlag, duplicateReason } : {}),
            });
          } else {
            // Skip expense creation - user will create expenses manually
            result.expensesCreated.push(null);
            result.results?.push({ index: i, status: 'extracted', expenseId: null });
          }
        } catch (error: any) {
          logger.error({ error: error.message, receipt }, 'Failed to create expense draft from Excel');
          result.errors.push(`Failed to create expense: ${error.message}`);
          result.expensesCreated.push(null);
          result.results?.push({ index: i, status: 'error', message: error.message });
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
    documentReceiptId?: string,
    companyId?: mongoose.Types.ObjectId,
    skipExpenseCreation: boolean = false
  ): Promise<DocumentProcessingResult> {
    logger.info({ storageKey, mimeType, documentReceiptId }, 'Processing image document');

    const result: DocumentProcessingResult = {
      success: true,
      receipts: [],
      expensesCreated: [],
      results: [],
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

      const prompt = `You are an OCR extraction engine.

Given an image of a receipt or invoice, extract ONLY the following fields.
If a field is not visible, return null.

Return STRICT JSON only. No explanations. No markdown.

For EACH receipt found in the image, return:
- vendor_name (string)
- invoice_number (string | null)
- invoice_date (ISO date string YYYY-MM-DD | null)
- total_amount (number | null)
- currency (string | null)
- tax_amount (number | null)
- line_items (array of { description, amount })

Rules:
- Do NOT guess values
- Do NOT hallucinate
- Use INR if currency symbol ₹ is present
- Dates must be YYYY-MM-DD
- Return JSON: {"receipts": [{"vendor_name": "...", "invoice_number": "...", "invoice_date": "YYYY-MM-DD", "total_amount": number, "currency": "...", "tax_amount": number, "line_items": [{"description": "...", "amount": number}]}]}
- If multiple receipts in image, include all in receipts array
- If no receipts found, return {"receipts": []}`;

      // OCR processing with concurrency limit and error handling
      await this.acquireOcrSlot();
      try {
        let content: string = '';
        const primaryModel = 'gpt-4o-mini';
        const fallbackModel = 'gpt-4o';
        let ocrError: any = null;
        
        try {
          // Try primary model first
          const response = await openaiClient.chat.completions.create({
            model: primaryModel,
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
            temperature: 0.0,
          });

          content = response.choices[0]?.message?.content || '';
          if (!content) {
            result.errors.push('OCR returned empty response');
            result.receipts = [];
            result.totalPages = 0;
            return result;
          }
        } catch (error: any) {
          ocrError = error;
          // Check if error is retryable (not authentication, not invalid model, etc.)
          const isRetryable = !(
            error.status === 401 || 
            error.message?.includes('authentication') || 
            error.message?.includes('Unauthorized') ||
            error.message?.includes('invalid_model') ||
            error.code === 'invalid_model'
          );

          if (isRetryable) {
            // Log fallback attempt
            logger.warn({ 
              primaryModel, 
              fallbackModel, 
              error: error.message 
            }, 'Primary OCR model failed, attempting fallback');
            
            // Try fallback model
            try {
              const fallbackResponse = await openaiClient.chat.completions.create({
                model: fallbackModel,
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
                temperature: 0.0,
              });

              content = fallbackResponse.choices[0]?.message?.content || '';
              if (!content) {
                result.errors.push('OCR returned empty response from fallback model');
                result.receipts = [];
                result.totalPages = 0;
                return result;
              }
            } catch (fallbackError: any) {
              // Both models failed - use fallback error for logging
              ocrError = fallbackError;
            }
          }
          
        }
        
        // If we still have an error after fallback attempt, handle it
        if (!content && ocrError) {
          // OCR failure - log detailed error for debugging
          const errorDetails = {
            message: ocrError.message,
              status: ocrError.status,
              code: ocrError.code,
              statusCode: ocrError.statusCode,
              response: ocrError.response?.data || ocrError.response,
            };
            
            // Log error details (only in non-production to avoid spam)
            if (config.app.env !== 'production') {
              const fileName = storageKey.split('/').pop() || storageKey;
              logger.error({ error: errorDetails, fileName }, 'OpenAI OCR API call failed');
            }
            
            // OCR failure - non-blocking, add error and continue
            let errorMsg = `OCR failed: ${ocrError.message || 'Unknown error'}`;
            
            // Provide helpful error messages
            if (ocrError.message?.includes('API key') || ocrError.message?.includes('authentication')) {
              errorMsg = 'OCR failed: Invalid or missing OPENAI_API_KEY. Please check your .env file.';
            } else if (ocrError.message?.includes('quota') || ocrError.message?.includes('rate limit')) {
              errorMsg = 'OCR failed: OpenAI API rate limit exceeded. Please try again later.';
            } else if (ocrError.statusCode === 400 || ocrError.code === 'invalid_argument') {
              errorMsg = `OCR failed: Invalid request to OpenAI API. ${ocrError.message || ''}`;
            }
            
            if (config.ocr.demoMode) {
              // Demo mode: silently ignore OCR failures
              result.receipts = [];
              result.totalPages = 0;
              return result;
            }
            result.errors.push(errorMsg);
            result.receipts = [];
            result.totalPages = 0;
            return result;
          }
        
          // Parse OpenAI response safely (only if we have content)
          if (content) {
            let receipts: ExtractedReceipt[] = [];
            try {
              let cleanedContent = content.trim();
              if (cleanedContent.startsWith('```json')) {
                cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              } else if (cleanedContent.startsWith('```')) {
                cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
              }

              const parsed = JSON.parse(cleanedContent);
              // Map response format to our internal format (support both vendor_name and vendor)
              receipts = (parsed.receipts || []).map((r: any) => {
                const normalized: ExtractedReceipt = {
                  vendor: r.vendor_name || r.vendor,
                  invoiceId: r.invoice_number || r.invoiceId || r.invoice_id,
                  date: r.invoice_date || r.date || r.invoiceDate,
                  totalAmount: r.total_amount || r.totalAmount,
                  currency: r.currency || 'INR',
                  tax: r.tax_amount || r.tax || r.taxAmount,
                  lineItems: r.line_items || r.lineItems,
                  sourceType: 'image' as const,
                  confidence: 0.85,
                };
                return this.normalizeAiReceipt(normalized);
              });
            } catch (parseError: any) {
              // JSON parsing failure - non-blocking, add error
              const errorMsg = `OCR response parsing failed: ${parseError.message}`;
              if (config.ocr.demoMode) {
                // Demo mode: silently ignore parsing failures
                result.receipts = [];
                result.totalPages = 0;
                return result;
              }
              result.errors.push(errorMsg);
              result.receipts = [];
              result.totalPages = 0;
              return result;
            }

            result.receipts = receipts;
            result.totalPages = receipts.length;
            await this.applyOcrPostProcessToReceipts(result.receipts, companyId);
          }
        } finally {
          this.releaseOcrSlot();
        }

      // Create expense drafts - ensure at least one draft is created per image
      if (result.receipts.length === 0) {
        // If no receipts extracted, create a placeholder draft expense
        try {
          const placeholderReceipt: ExtractedReceipt = {
            vendor: 'Receipt Processing...',
            totalAmount: 0,
            currency: 'INR',
            date: new Date().toISOString().split('T')[0],
            categorySuggestion: 'Others',
            categoryUnidentified: true,
            notes: 'Please review and enter details manually',
            sourceType: 'image',
            confidence: 0,
          };
          if (!skipExpenseCreation) {
            const expenseId = await this.createExpenseDraft(
              placeholderReceipt,
              reportId,
              userId,
              documentReceiptId,
              'image',
              1
            );
            result.expensesCreated.push(expenseId);
            result.results?.push({ index: 0, status: 'created', expenseId });
          } else {
            // Skip expense creation - user will create expenses manually
            result.expensesCreated.push(null);
            result.results?.push({ index: 0, status: 'extracted', expenseId: null });
          }
          result.receipts.push(placeholderReceipt);
        } catch (error: any) {
          logger.error({ error: error.message }, 'Failed to create placeholder expense draft');
          result.errors.push(`Failed to create placeholder expense: ${error.message}`);
          result.expensesCreated.push(null);
          result.results?.push({ index: 0, status: 'error', message: error.message });
        }
      } else {
        // Create expense drafts for each extracted receipt. Duplicate detection is flag-only (no skip).
        for (let i = 0; i < result.receipts.length; i++) {
          const receipt = result.receipts[i];
          try {
            if (!skipExpenseCreation) {
              const expenseId = await this.createExpenseDraft(
                receipt,
                reportId,
                userId,
                documentReceiptId, // Link image document to expenses
                'image', // Source document type
                i + 1 // Sequence number (1-indexed)
              );
              result.expensesCreated.push(expenseId);
              let duplicateFlag: string | null = null;
              let duplicateReason: string | null = null;
              try {
                const { DuplicateDetectionService } = await import('./duplicateDetection.service');
                const dr = await DuplicateDetectionService.runDuplicateCheck(expenseId, companyId);
                duplicateFlag = dr.duplicateFlag;
                duplicateReason = dr.duplicateReason;
              } catch (_) { /* non-blocking */ }
              result.results?.push({
                index: i,
                status: 'created',
                expenseId,
                ...(duplicateFlag && duplicateReason ? { duplicateFlag, duplicateReason } : {}),
              });
            } else {
              // Skip expense creation - user will create expenses manually
              result.expensesCreated.push(null);
              result.results?.push({ index: i, status: 'extracted', expenseId: null });
            }
          } catch (error: any) {
            logger.error({ error: error.message }, 'Failed to create expense draft from image');
            result.errors.push(`Failed to create expense: ${error.message}`);
            result.expensesCreated.push(null);
            result.results?.push({ index: i, status: 'error', message: error.message });
          }
        }
      }

    } catch (error: any) {
      // Non-OCR errors (S3, sharp, etc.) - log but don't fail completely
      if (config.ocr.demoMode) {
        // Demo mode: silently ignore all errors
        result.receipts = [];
        result.totalPages = 0;
        return result;
      }
      
      // If we have receipts extracted, don't mark as completely failed
      // Only mark as failed if no receipts were extracted
      if (result.receipts.length === 0 && result.expensesCreated.length === 0) {
        result.success = false;
        result.errors.push(`Image processing failed: ${error.message}`);
      } else {
        // Partial success - receipts extracted but some errors occurred
        result.errors.push(`Some errors occurred during processing: ${error.message}`);
      }
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
    documentReceiptId?: string,
    sourceDocumentType?: 'pdf' | 'excel' | 'image',
    sourceDocumentSequence?: number
  ): Promise<string> {
    const report = await ExpenseReport.findById(reportId).select('fromDate toDate').exec();
    if (!report) throw new Error('Report not found');

    const confidence = typeof receipt.confidence === 'number' ? receipt.confidence : 0;
    const threshold = (config.ocr as any).confidenceThreshold ?? 0.75;
    const categoryUnidentified = receipt.categoryUnidentified === true;
    const needsReview = confidence < threshold || categoryUnidentified;

    // Resolve category: use post-process categoryId if matched; otherwise Others when unidentified
    let categoryId: mongoose.Types.ObjectId | undefined;
    let expenseDate: Date;
    if (receipt.categoryId) {
      categoryId = receipt.categoryId;
    } else if (receipt.categorySuggestion && !categoryUnidentified) {
      const category = await Category.findOne({
        name: { $regex: new RegExp(`^${receipt.categorySuggestion}$`, 'i') }
      });
      if (category) categoryId = category._id as mongoose.Types.ObjectId;
    }
    if (!categoryId) {
      const defaultCategory = await Category.findOne({ name: { $regex: /^(Other|Others|Miscellaneous|Misc|General)$/i } }) || await Category.findOne({});
      if (defaultCategory) categoryId = defaultCategory._id as mongoose.Types.ObjectId;
    }

    if (needsReview) {
      expenseDate = report.fromDate;
    } else {
      // Parse date from receipt - handle both string and Date formats
      let invoiceDate: Date | undefined;
      if (receipt.date) {
        if (typeof receipt.date === 'string') {
          // Try parsing as YYYY-MM-DD first (frontend format)
          if (/^\d{4}-\d{2}-\d{2}$/.test(receipt.date)) {
            invoiceDate = DateUtils.frontendDateToBackend(receipt.date);
          } else {
            // Try parsing as ISO string or other formats
            invoiceDate = new Date(receipt.date);
            if (isNaN(invoiceDate.getTime())) {
              invoiceDate = undefined;
            }
          }
        } else if (receipt.date && typeof receipt.date !== 'string') {
          // receipt.date is a Date object
          invoiceDate = receipt.date as Date;
        }
      }
      
      expenseDate = invoiceDate && !isNaN(invoiceDate.getTime()) ? invoiceDate : new Date();
      if (!DateUtils.isDateInReportRange(expenseDate, report.fromDate, report.toDate)) {
        logger.error({
          expenseDate: DateUtils.backendDateToFrontend(expenseDate),
          reportFromDate: DateUtils.backendDateToFrontend(report.fromDate),
          reportToDate: DateUtils.backendDateToFrontend(report.toDate),
        }, 'Expense date validation failed in createExpenseDraft - REJECTING');
        throw new Error(
          `Extracted date (${DateUtils.backendDateToFrontend(expenseDate)}) is outside report range (${DateUtils.backendDateToFrontend(report.fromDate)} to ${DateUtils.backendDateToFrontend(report.toDate)})`
        );
      }
    }

    const receiptIds: mongoose.Types.ObjectId[] = [];
    if (documentReceiptId) receiptIds.push(new mongoose.Types.ObjectId(documentReceiptId));

    // Parse invoice date - handle both string and Date formats
    let invoiceDate: Date | undefined;
    if (receipt.date) {
      if (typeof receipt.date === 'string') {
        // Try parsing as YYYY-MM-DD first (frontend format)
        if (/^\d{4}-\d{2}-\d{2}$/.test(receipt.date)) {
          invoiceDate = DateUtils.frontendDateToBackend(receipt.date);
        } else {
          // Try parsing as ISO string or other formats
          invoiceDate = new Date(receipt.date);
          if (isNaN(invoiceDate.getTime())) {
            invoiceDate = undefined;
          }
        }
      } else if (receipt.date && typeof receipt.date !== 'string') {
        // receipt.date is a Date object
        invoiceDate = receipt.date as Date;
      }
    }
    
    // Invoice date must be within report [fromDate, toDate] if provided
    if (invoiceDate && !isNaN(invoiceDate.getTime())) {
      if (!DateUtils.isDateInReportRange(invoiceDate, report.fromDate, report.toDate)) {
        logger.error({
          invoiceDate: DateUtils.backendDateToFrontend(invoiceDate),
          reportFromDate: DateUtils.backendDateToFrontend(report.fromDate),
          reportToDate: DateUtils.backendDateToFrontend(report.toDate),
        }, 'Invoice date validation failed in createExpenseDraft - REJECTING');
        throw new Error(
          `Invoice date (${DateUtils.backendDateToFrontend(invoiceDate)}) must be within report date range (${DateUtils.backendDateToFrontend(report.fromDate)} to ${DateUtils.backendDateToFrontend(report.toDate)})`
        );
      }
    }
    
    const invoiceId = receipt.invoiceId?.toString().trim() || undefined;
    let invoiceFingerprint: string | undefined = undefined;
    if (invoiceId && invoiceDate && !isNaN(invoiceDate.getTime()) && typeof receipt.totalAmount === 'number') {
      const { DuplicateInvoiceService } = await import('./duplicateInvoice.service');
      invoiceFingerprint = DuplicateInvoiceService.computeFingerprint(
        invoiceId,
        receipt.vendor || 'Receipt Processing...',
        invoiceDate,
        receipt.totalAmount
      );
    }

    const expense = new Expense({
      reportId: new mongoose.Types.ObjectId(reportId),
      userId: new mongoose.Types.ObjectId(userId),
      vendor: receipt.vendor || 'Receipt Processing...',
      categoryId,
      amount: receipt.totalAmount || 0,
      currency: receipt.currency || 'INR',
      expenseDate,
      status: ExpenseStatus.DRAFT,
      source: receipt.sourceType === 'excel' ? 'MANUAL' : 'SCANNED',
      notes: receipt.notes || (receipt.lineItems && receipt.lineItems.length > 0
        ? receipt.lineItems.map(item => item.description).filter(Boolean).join(', ')
        : undefined),
      receiptIds,
      receiptPrimaryId: documentReceiptId ? new mongoose.Types.ObjectId(documentReceiptId) : undefined,
      invoiceId,
      invoiceDate: invoiceDate && !isNaN(invoiceDate.getTime()) ? invoiceDate : undefined,
      invoiceFingerprint,
      sourceDocumentType,
      sourceDocumentSequence,
      needsReview: needsReview || undefined,
      ocrConfidence: needsReview ? confidence : undefined,
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

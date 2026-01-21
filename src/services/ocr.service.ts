import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';

import { s3Client, getS3Bucket } from '../config/aws';
import { config } from '../config/index';
import { openaiClient, getVisionModel } from '../config/openai';
import { Expense } from '../models/Expense';
import { OcrJob, IOcrJob } from '../models/OcrJob';
import { Receipt } from '../models/Receipt';
import { OcrJobStatus } from '../utils/enums';

import { logger } from '@/config/logger';
import { DateUtils } from '@/utils/dateUtils';
import { CategoryMatchingService } from './categoryMatching.service';

export interface OcrResult {
  vendor?: string;
  date?: string;
  totalAmount?: number;
  currency?: string;
  tax?: number;
  lineItems?: Array<{ description: string; amount: number }>;
  notes?: string;
  confidence?: number;
}

export class OcrService {
  /**
   * Process OCR synchronously (no queue) - simple implementation
   */
  static async processReceiptSync(receiptId: string): Promise<IOcrJob> {
    const receipt = await Receipt.findById(receiptId);

    if (!receipt) {
      throw new Error('Receipt not found');
    }

    // Check if OCR is disabled
    if (config.ocr.disableOcr) {
      logger.info({ receiptId }, 'OCR is disabled, creating placeholder job');
      const ocrJob = new OcrJob({
        status: OcrJobStatus.COMPLETED,
        provider: 'DISABLED',
        receiptId,
        result: { message: 'OCR disabled by configuration' },
        attempts: 0,
      });
      const saved = await ocrJob.save();
      receipt.ocrJobId = saved._id as mongoose.Types.ObjectId;
      await receipt.save();
      return saved;
    }

    // Create OCR job
    const ocrJob = new OcrJob({
      status: OcrJobStatus.PROCESSING,
      provider: 'OPENAI',
      receiptId,
      attempts: 0,
    });

    const saved = await ocrJob.save();
    receipt.ocrJobId = saved._id as mongoose.Types.ObjectId;
    await receipt.save();

    // Process immediately (synchronously)
    try {
      return await this.processOcrJob((saved._id as any).toString());
    } catch (error: any) {
      logger.error({
        jobId: saved._id,
        receiptId,
        error: error.message,
      }, 'OCR processing failed');
      throw error;
    }
  }

  static async processOcrJob(jobId: string): Promise<IOcrJob> {
    const job = await OcrJob.findById(jobId).populate('receiptId');

    if (!job) {
      throw new Error('OCR job not found');
    }

    job.status = OcrJobStatus.PROCESSING;
    await job.save();

    try {
      const receiptPopulated = job.receiptId as any;
      
      if (!receiptPopulated) {
        throw new Error('Receipt not found for OCR job');
      }

      logger.info({
        jobId,
        receiptId: receiptPopulated._id,
        storageKey: receiptPopulated.storageKey,
        mimeType: receiptPopulated.mimeType,
      }, 'Verifying receipt exists in S3');

      const bucket = getS3Bucket('receipts');

      // First, verify the object exists in S3
      try {
        const headCommand = new HeadObjectCommand({
          Bucket: bucket,
          Key: receiptPopulated.storageKey,
        });
        await s3Client.send(headCommand);
        logger.info({
          jobId,
          storageKey: receiptPopulated.storageKey,
        }, 'Receipt verified in S3');
      } catch (headError: any) {
        if (headError.name === 'NotFound' || headError.$metadata?.httpStatusCode === 404) {
          logger.error({
            jobId,
            receiptId: receiptPopulated._id,
            storageKey: receiptPopulated.storageKey,
          }, 'Receipt not found in S3 - upload may not have completed');
          job.status = OcrJobStatus.FAILED;
          job.error = 'Receipt file not found in S3. Please ensure the upload completed successfully.';
          await job.save();
          throw new Error('Receipt file not found in S3');
        }
        throw headError;
      }

      logger.info({
        jobId,
        receiptId: receiptPopulated._id,
        storageKey: receiptPopulated.storageKey,
        mimeType: receiptPopulated.mimeType,
      }, 'Downloading receipt from S3');

      // Download image from S3
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: receiptPopulated.storageKey,
      });

      const response = await s3Client.send(command);
      
      if (!response.Body) {
        logger.error({ jobId, storageKey: receiptPopulated.storageKey }, 'S3 response has no body');
        job.status = OcrJobStatus.FAILED;
        job.error = 'S3 object has no body content';
        await job.save();
        throw new Error('S3 object has no body content');
      }
      
      const imageBuffer = await this.streamToBuffer(response.Body);

      logger.info({ 
        sizeBytes: imageBuffer.length,
        jobId,
      }, 'Receipt downloaded from S3');

      // Convert to base64
      const base64Image = imageBuffer.toString('base64');

      logger.info({
        model: getVisionModel(),
        imageSize: base64Image.length,
        mimeType: receiptPopulated.mimeType,
        jobId,
      }, 'Calling OpenAI Vision API')

      // Call OpenAI Vision API
      const result = await this.callOpenAIVision(base64Image, receiptPopulated.mimeType);
      
      logger.info({
        extractedFields: Object.keys(result),
        hasVendor: !!result.vendor,
        hasAmount: !!result.totalAmount,
        hasDate: !!result.date,
        jobId,
      }, 'OpenAI Vision API call successful')

      // Save result to both result and resultJson for compatibility
      job.status = OcrJobStatus.COMPLETED;
      job.result = result;
      job.resultJson = result;
      job.completedAt = new Date();
      await job.save();

      // Update receipt with parsedData
      const receiptDoc = await Receipt.findById(job.receiptId);
      if (receiptDoc) {
        receiptDoc.parsedData = result;
        await receiptDoc.save();
        logger.info({ receiptId: receiptDoc._id }, 'Receipt updated with parsed data');
      }

      // Auto-fill expense fields if expense exists and report is still DRAFT
      // Try to find expense by receiptPrimaryId or by receiptIds array
      const receiptIdForSearch = receiptDoc?._id || receiptPopulated?._id;
      const expense = await Expense.findOne({
        $or: [
          { receiptPrimaryId: receiptIdForSearch },
          { receiptIds: receiptIdForSearch }
        ]
      })
        .populate('reportId');
      
      if (expense) {
        const report = expense.reportId as any;
        
        // Only auto-update if report is DRAFT
        if (report.status === 'DRAFT') {
          let updated = false;
          
          if (result.vendor && result.vendor.trim()) {
            expense.vendor = result.vendor.trim();
            updated = true;
          }
          
          if (result.totalAmount && result.totalAmount > 0) {
            expense.amount = result.totalAmount;
            updated = true;
          }
          
          if (result.date) {
            try {
              if (DateUtils.isValidDateString(result.date)) {
                expense.expenseDate = DateUtils.parseISTDate(result.date);
                updated = true;
                logger.info({ receiptId: receiptDoc?._id, date: result.date }, 'OCR date parsed successfully as IST date');
              } else {
                logger.warn({ receiptId: receiptDoc?._id, date: result.date }, 'Invalid date format from OCR, skipping expense date update');
              }
            } catch (e) {
              logger.warn({ receiptId: receiptDoc?._id, date: result.date, error: (e as Error).message }, 'Error parsing OCR date');
            }
          }
          
          if (result.currency && result.currency.trim()) {
            expense.currency = result.currency.trim().toUpperCase();
            updated = true;
          }
          
          // Use AI-powered category matching
          try {
            const categoryMatch = await CategoryMatchingService.findBestCategoryMatch({
              vendor: result.vendor,
              lineItems: result.lineItems,
              notes: result.notes,
              extractedText: result.notes || '' // Use notes as extracted text fallback
            }, (expense as any).companyId);

            if (categoryMatch.bestMatch && categoryMatch.bestMatch.confidence >= 50) {
              expense.categoryId = categoryMatch.bestMatch.categoryId;
              updated = true;
              logger.info({
                receiptId: receiptDoc?._id,
                matchedCategory: categoryMatch.bestMatch?.categoryName,
                confidence: categoryMatch.bestMatch?.confidence
              }, 'AI category matching successful');
        } else if (categoryMatch.fallbackCategory) {
          // Use fallback category if no good match
          expense.categoryId = categoryMatch.fallbackCategory.categoryId;
          updated = true;
          logger.info({
            receiptId: receiptDoc?._id,
            fallbackCategory: categoryMatch.fallbackCategory.categoryName
          }, 'Using fallback category due to low AI confidence');
        }
          } catch (error: any) {
            logger.warn({
              receiptId: receiptDoc?._id,
              error: (error as Error).message
            }, 'AI category matching failed, skipping category assignment');
          }
          
          if (result.lineItems && Array.isArray(result.lineItems) && result.lineItems.length > 0) {
            // Combine line items into notes if notes is empty
            if (!expense.notes || expense.notes.trim() === '') {
              const lineItemsText = result.lineItems
                .map((item: any) => `${item.description || 'Item'}: ${item.amount || 0}`)
                .join('\n');
              expense.notes = lineItemsText;
              updated = true;
            }
          } else if (result.notes && result.notes.trim()) {
            // Use extracted notes if available
            if (!expense.notes || expense.notes.trim() === '') {
              expense.notes = result.notes.trim();
              updated = true;
            }
          }
          
          if (updated) {
            await expense.save();
            // Recalculate report totals
            const { ReportsService } = await import('./reports.service');
            await ReportsService.recalcTotals(report._id.toString());
          }
        }
      }

      logger.info({ jobId }, 'OCR job completed and expense updated');
      return job;
    } catch (error: any) {
      logger.error({
        jobId,
        error: error.message,
        stack: error.stack,
        name: error.name,
      }, 'OCR processing error');
      job.status = OcrJobStatus.FAILED;
      job.error = error.message;
      job.errorJson = {
        message: error.message,
        stack: error.stack,
        name: error.name,
      };
      job.attempts = (job.attempts || 0) + 1;
      await job.save();
      throw error;
    }
  }

  private static async streamToBuffer(stream: any): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  private static async callOpenAIVision(
    base64Image: string,
    mimeType: string
  ): Promise<OcrResult> {
    const model = getVisionModel();

    const prompt = `Extract receipt data as JSON only. Fields: vendor (string), date (YYYY-MM-DD), totalAmount (number), currency (INR/USD/EUR), tax (number, optional), lineItems ([{description, amount}]), notes (string, optional). Return JSON only, no markdown. Do not suggest categories - that will be handled separately.`;

    try {
      logger.info({
        model,
        imageSize: base64Image.length,
        mimeType,
      }, 'Preparing OpenAI API request')

      // OpenAI vision API format
      const response = await openaiClient.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { 
                type: 'text', 
                text: prompt 
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                  detail: 'high', // Use high detail for better OCR accuracy
                },
              },
            ],
          },
        ],
        max_tokens: 1500, // Reduced for faster response
        response_format: { type: 'json_object' }, // Force JSON response format
        temperature: 0.0, // Zero temperature for fastest, most consistent results
      });

      logger.info({
        model,
        usage: response.usage,
        finishReason: response.choices[0]?.finish_reason,
      }, 'OpenAI API call successful')

      const content = response.choices[0]?.message?.content;
      if (!content) {
        logger.error('OpenAI returned empty response');
        throw new Error('No response from OpenAI');
      }

      // Clean the content - remove markdown code blocks if present
      let cleanedContent = content.trim();
      if (cleanedContent.startsWith('```json')) {
        cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedContent.startsWith('```')) {
        cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      // Parse JSON response
      try {
        const result = JSON.parse(cleanedContent) as OcrResult;
        result.confidence = 0.85; // Default confidence, could be calculated
        
        // Log successful extraction
        logger.info({
          vendor: result.vendor,
          totalAmount: result.totalAmount,
          date: result.date,
          currency: result.currency,
          hasLineItems: !!(result.lineItems && result.lineItems.length > 0),
          lineItemsCount: result.lineItems?.length || 0,
        }, 'OCR extraction successful')
        
        // Validate that we got at least some data
        if (!result.vendor && !result.totalAmount && !result.date) {
          logger.warn({ result }, 'OCR extraction returned minimal data');
        }
        
        return result;
      } catch (error) {
        // If not JSON, try to extract structured data
        logger.warn({
          content: cleanedContent.substring(0, 200), // Log first 200 chars
          error: error instanceof Error ? error.message : String(error),
        }, 'OpenAI response not in JSON format, attempting to parse:')
        const parsed = this.parseUnstructuredResponse(cleanedContent);
        logger.info({ parsed }, 'Parsed unstructured response');
        return parsed;
      }
    } catch (error: any) {
      logger.error({
        error: error.message,
        name: error.name,
        status: error.status,
        code: error.code,
        model,
        stack: error.stack,
      }, 'OpenAI API call failed')
      
      // Provide more helpful error messages
      if (error.message?.includes('model') || error.code === 'invalid_model' || error.status === 404) {
        throw new Error(
          `OpenAI model "${model}" not found or not available.\n` +
          `Please check:\n` +
          `1. Model name is correct in .env file (OPENAI_MODEL_VISION)\n` +
          `2. Model is available in your OpenAI account\n` +
          `3. Model supports vision/image inputs\n` +
          `Recommended vision models: gpt-4o, gpt-4o-mini, gpt-4-turbo`
        );
      } else if (error.message?.includes('vision') || error.message?.includes('image')) {
        throw new Error(
          `OpenAI model "${model}" may not support vision/image inputs.\n` +
          `Please use a vision-capable model like: gpt-4o`
        );
      } else if (error.status === 401 || error.message?.includes('authentication') || error.message?.includes('Unauthorized')) {
        throw new Error(
          'OpenAI authentication failed.\n' +
          'Please check:\n' +
          '1. OPENAI_API_KEY is set correctly in .env file\n' +
          '2. API key is valid and has sufficient credits\n' +
          '3. API key has access to vision models'
        );
      } else if (error.status === 429 || error.message?.includes('rate limit')) {
        throw new Error(
          'OpenAI rate limit exceeded.\n' +
          'Please wait a moment and try again, or check your OpenAI account limits.'
        );
      }
      
      throw new Error(`OpenAI API error: ${error.message || 'Unknown error'}\nStatus: ${error.status || 'N/A'}\nCode: ${error.code || 'N/A'}`);
    }
  }

  private static parseUnstructuredResponse(content: string): OcrResult {
    // Fallback parser for non-JSON responses
    const result: OcrResult = {};
    
    logger.warn({
      contentLength: content.length,
      preview: content.substring(0, 200),
    }, 'Attempting to parse unstructured OCR response')

    // Try to extract vendor - multiple patterns
    const vendorPatterns = [
      /vendor[:\s]+([^\n,]+)/i,
      /merchant[:\s]+([^\n,]+)/i,
      /store[:\s]+([^\n,]+)/i,
      /"vendor"\s*:\s*"([^"]+)"/i,
    ];
    
    for (const pattern of vendorPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        result.vendor = match[1].trim();
        break;
      }
    }

    // Try to extract amount - multiple patterns
    const amountPatterns = [
      /total[:\s]+([\d.]+)/i,
      /amount[:\s]+([\d.]+)/i,
      /"totalAmount"\s*:\s*([\d.]+)/i,
      /₹\s*([\d,]+\.?\d*)/i,
      /\$\s*([\d,]+\.?\d*)/i,
      /(\d+\.\d{2})/,
    ];
    
    for (const pattern of amountPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        const amountStr = match[1].replace(/,/g, '');
        const amount = parseFloat(amountStr);
        if (!isNaN(amount) && amount > 0) {
          result.totalAmount = amount;
          break;
        }
      }
    }
    
    // Try to extract date - multiple patterns
    const datePatterns = [
      /date[:\s]+([\d-]+)/i,
      /"date"\s*:\s*"([^"]+)"/i,
      /(\d{4}-\d{2}-\d{2})/,
      /(\d{2}\/\d{2}\/\d{4})/,
      /(\d{2}-\d{2}-\d{4})/,
    ];
    
    for (const pattern of datePatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        result.date = match[1];
        break;
      }
    }
    
    // Try to extract currency
    const currencyMatch = content.match(/"currency"\s*:\s*"([^"]+)"/i) ||
                         content.match(/currency[:\s]+([A-Z]{3})/i);
    if (currencyMatch) {
      result.currency = currencyMatch[1].trim().toUpperCase();
    }
    
    // Category matching is now handled separately via AI service

    logger.info({
      extractedFields: Object.keys(result),
      hasVendor: !!result.vendor,
      hasAmount: !!result.totalAmount,
    }, 'Parsed unstructured response')

    return result;
  }

  static async getOcrJobStatus(id: string): Promise<IOcrJob | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return OcrJob.findById(id).populate('receiptId').exec();
  }
}

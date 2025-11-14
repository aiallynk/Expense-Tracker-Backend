import { OcrJob, IOcrJob } from '../models/OcrJob';
import { Receipt } from '../models/Receipt';
import { Expense } from '../models/Expense';
import { OcrJobStatus } from '../utils/enums';
import { openaiClient, getVisionModel } from '../config/openai';
import { s3Client, getS3Bucket } from '../config/aws';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '../utils/logger';
import mongoose from 'mongoose';

export interface OcrResult {
  vendor?: string;
  date?: string;
  totalAmount?: number;
  currency?: string;
  tax?: number;
  categorySuggestion?: string;
  lineItems?: Array<{ description: string; amount: number }>;
  confidence?: number;
}

export class OcrService {
  static async enqueueOcrJob(receiptId: string): Promise<IOcrJob> {
    const receipt = await Receipt.findById(receiptId);

    if (!receipt) {
      throw new Error('Receipt not found');
    }

    const ocrJob = new OcrJob({
      status: OcrJobStatus.QUEUED,
      provider: 'OPENAI_VISION',
      receiptId,
    });

    const saved = await ocrJob.save();

    // Update receipt with OCR job ID
    receipt.ocrJobId = saved._id as mongoose.Types.ObjectId;
    await receipt.save();

    // Process immediately (in production, use a queue)
    this.processOcrJob((saved._id as mongoose.Types.ObjectId).toString()).catch((error) => {
      logger.error('OCR job processing error:', error);
    });

    return saved;
  }

  static async processOcrJob(jobId: string): Promise<IOcrJob> {
    const job = await OcrJob.findById(jobId).populate('receiptId');

    if (!job) {
      throw new Error('OCR job not found');
    }

    job.status = OcrJobStatus.PROCESSING;
    await job.save();

    try {
      const receipt = job.receiptId as any;
      const bucket = getS3Bucket('receipts');

      // Download image from S3
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: receipt.storageKey,
      });

      const response = await s3Client.send(command);
      const imageBuffer = await this.streamToBuffer(response.Body as any);

      // Convert to base64
      const base64Image = imageBuffer.toString('base64');

      // Call OpenAI Vision API
      const result = await this.callOpenAIVision(base64Image, receipt.mimeType);

      // Save result
      job.status = OcrJobStatus.COMPLETED;
      job.resultJson = result;
      job.completedAt = new Date();
      await job.save();

      // Optionally auto-fill expense fields
      const expense = await Expense.findOne({ receiptPrimaryId: receipt._id });
      if (expense && result.vendor && result.totalAmount) {
        expense.vendor = result.vendor;
        expense.amount = result.totalAmount;
        if (result.date) {
          expense.expenseDate = new Date(result.date);
        }
        await expense.save();
      }

      return job;
    } catch (error: any) {
      logger.error('OCR processing error:', error);
      job.status = OcrJobStatus.FAILED;
      job.errorJson = {
        message: error.message,
        stack: error.stack,
      };
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

    const prompt = `Extract the following information from this receipt image:
- vendor/merchant name
- date of transaction
- total amount
- currency
- tax amount (if visible)
- category suggestion (Travel, Food, Office, Others, etc.)
- line items (description and amount for each item)

Return the data as a JSON object with these fields. If a field is not found, omit it.`;

    const response = await openaiClient.chat.completions.create({
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
              },
            },
          ],
        },
      ],
      max_tokens: 1000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from OpenAI');
    }

    // Parse JSON response
    try {
      const result = JSON.parse(content) as OcrResult;
      result.confidence = 0.85; // Default confidence, could be calculated
      return result;
    } catch (error) {
      // If not JSON, try to extract structured data
      logger.warn('OpenAI response not in JSON format, attempting to parse:', content);
      return this.parseUnstructuredResponse(content);
    }
  }

  private static parseUnstructuredResponse(content: string): OcrResult {
    // Fallback parser for non-JSON responses
    const result: OcrResult = {};

    // Try to extract vendor
    const vendorMatch = content.match(/vendor[:\s]+([^\n,]+)/i);
    if (vendorMatch) {
      result.vendor = vendorMatch[1].trim();
    }

    // Try to extract amount
    const amountMatch = content.match(/total[:\s]+([\d.]+)/i);
    if (amountMatch) {
      result.totalAmount = parseFloat(amountMatch[1]);
    }

    // Try to extract date
    const dateMatch = content.match(/date[:\s]+([^\n,]+)/i);
    if (dateMatch) {
      result.date = dateMatch[1].trim();
    }

    return result;
  }

  static async getOcrJobStatus(id: string): Promise<IOcrJob | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return OcrJob.findById(id).populate('receiptId').exec();
  }
}


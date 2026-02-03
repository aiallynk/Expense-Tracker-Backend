import * as fs from 'fs';
import * as path from 'path';

import { getGeminiVisionModel } from '../../lib/gemini';

/**
 * TEMP DISABLED: OpenAI OCR temporarily disabled for local testing
 * This service uses Gemini Vision for local OCR testing
 * 
 * Process local image file using Gemini Vision API
 * @param imagePath - Local file path to image
 * @returns Raw Gemini response text
 */
export class GeminiOcrService {
  static async processLocalImage(imagePath: string): Promise<string> {
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }

    // Read image file
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    
    // Get file extension to determine MIME type
    const ext = path.extname(imagePath).toLowerCase();
    let mimeType = 'image/jpeg';
    if (ext === '.png') {
      mimeType = 'image/png';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.webp') {
      mimeType = 'image/webp';
    }

    const model = getGeminiVisionModel();

    const prompt = `You are an OCR extraction engine.

Given an image of a receipt or invoice, extract ONLY the following fields.
If a field is not visible, return null.

Return STRICT JSON only. No explanations. No markdown.

Fields:
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
- Map currency symbols: $ → USD, € → EUR, £ → GBP, ₹ → INR. Use INR only when you see ₹ or INR/Rupees/Rs. Do NOT default to INR for $/€/£ receipts.
- Dates must be YYYY-MM-DD
- Return JSON: {"vendor_name": "...", "invoice_number": "...", "invoice_date": "YYYY-MM-DD", "total_amount": number, "currency": "...", "tax_amount": number, "line_items": [{"description": "...", "amount": number}]}`;

    try {
      // Gemini API format: simple array [prompt, image]
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Image,
          },
        },
      ]);

      const response = await result.response;
      const text = response.text();
      
      return text;
    } catch (error: any) {
      throw new Error(`Gemini OCR failed: ${error.message || 'Unknown error'}`);
    }
  }
}

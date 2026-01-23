import * as path from 'path';
import { GeminiOcrService } from '../services/ocr/geminiOcr.service';

/**
 * Local test file for Gemini OCR
 * Usage: tsx src/tests/gemini.local.test.ts
 * 
 * Place a test image named "receipt.jpg" in the project root
 */
async function testGeminiOcr() {
  const imagePath = path.join(process.cwd(), 'receipt.jpg');
  
  console.log('Testing Gemini OCR...');
  console.log(`Image path: ${imagePath}`);
  
  try {
    const result = await GeminiOcrService.processLocalImage(imagePath);
    console.log('\n=== Gemini OCR Result ===');
    console.log(result);
    console.log('\n=== Test Complete ===');
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

testGeminiOcr();

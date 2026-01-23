import { GoogleGenerativeAI } from '@google/generative-ai';

// TEMP DISABLED: OpenAI OCR temporarily disabled for local testing
// OpenAI client initialization is commented out in openai.ts

// Initialize Gemini Client (lazy initialization to avoid throwing on import)
let geminiClient: GoogleGenerativeAI | null = null;

const getGeminiClient = (): GoogleGenerativeAI => {
  if (!geminiClient) {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY is required in .env file for Gemini OCR. Please add GEMINI_API_KEY=your_api_key to your .env file.');
    }
    
    // Validate API key format (Gemini API keys typically start with specific patterns)
    if (geminiApiKey.trim().length < 20) {
      throw new Error('GEMINI_API_KEY appears to be invalid. Gemini API keys are typically longer than 20 characters.');
    }
    
    try {
      geminiClient = new GoogleGenerativeAI(geminiApiKey.trim());
    } catch (error: any) {
      throw new Error(`Failed to initialize Gemini client: ${error.message || 'Unknown error'}`);
    }
  }
  return geminiClient;
};

// Get Gemini Vision model
export const getGeminiVisionModel = () => {
  return getGeminiClient().getGenerativeModel({ model: 'gemini-1.5-flash' });
};

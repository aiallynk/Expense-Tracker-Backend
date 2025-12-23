// ... (top of file remains unchanged, update logic below)

// REMOVE TogetherAI diagnostic section
// Instead, check OpenAI:
async function checkOpenAI() {
  console.log('\n=== Checking OpenAI Configuration ===');
  console.log(`OpenAI API Key: ${config.openai.apiKey ? `${config.openai.apiKey.substring(0, 8)}...` : 'NOT SET'}`);
  console.log(`OpenAI Vision Model: ${config.openai.modelVision}`);
  console.log(`OpenAI Base URL: ${config.openai.baseUrl}`);
  console.log(`OCR Disabled: ${config.ocr.disableOcr ? '✅ YES (OCR is disabled)' : '❌ NO (OCR is enabled)'}`);
  if (config.ocr.disableOcr) {
    console.log('\n⚠️  OCR is disabled. Set DISABLE_OCR=false in .env to enable OCR processing.');
    return false;
  }
  if (!config.openai.apiKey) {
    console.log('\n❌ OpenAI API key is not set. Set OPENAI_API_KEY in .env');
    return false;
  }
  return true;
}

// ...
// When running diagnostics in main(), replace TogetherAI check with OpenAI check:
// const openAIOk = await checkOpenAI();
// ...and pass through summary

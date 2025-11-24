/**
 * Diagnostic script to check:
 * 1. If S3 is configured correctly
 * 2. If OCR worker is running and processing jobs
 * 3. If Together AI is being called
 * 
 * Run: npm run check:ocr-s3
 * Or: tsx scripts/check-ocr-and-s3.ts
 */

import { connectDB } from '../src/config/db';
import { config } from '../src/config/index';
import { s3Client, getS3Bucket } from '../src/config/aws';
import { bucketExists } from '../src/utils/s3';
import { ocrQueue } from '../src/config/queue';
import { OcrJob } from '../src/models/OcrJob';
import { Receipt } from '../src/models/Receipt';
import { HeadBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { logger } from '../src/utils/logger';

async function checkS3() {
  console.log('\n=== Checking S3 Configuration ===');
  
  const bucket = getS3Bucket('receipts');
  console.log(`S3 Bucket: ${bucket}`);
  console.log(`AWS Region: ${config.aws.region}`);
  console.log(`AWS Access Key ID: ${config.aws.accessKeyId ? `${config.aws.accessKeyId.substring(0, 8)}...` : 'NOT SET'}`);
  console.log(`AWS Secret Key: ${config.aws.secretAccessKey ? 'SET' : 'NOT SET'}`);

  try {
    // Check if bucket exists
    const exists = await bucketExists(bucket);
    console.log(`Bucket exists: ${exists ? '✅ YES' : '❌ NO'}`);

    if (exists) {
      // Try to list objects (check permissions)
      try {
        const listCommand = new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: 5,
        });
        const response = await s3Client.send(listCommand);
        const objectCount = response.KeyCount || 0;
        console.log(`Bucket is accessible: ✅ YES`);
        console.log(`Objects in bucket: ${objectCount} (showing first 5)`);
        
        if (response.Contents && response.Contents.length > 0) {
          console.log('Sample objects:');
          response.Contents.forEach((obj, idx) => {
            console.log(`  ${idx + 1}. ${obj.Key} (${obj.Size} bytes, modified: ${obj.LastModified})`);
          });
        }
      } catch (error: any) {
        console.log(`Bucket access check: ⚠️  ${error.message}`);
      }
    }
  } catch (error: any) {
    console.error(`❌ S3 Error: ${error.message}`);
    return false;
  }

  return true;
}

async function checkRedis() {
  console.log('\n=== Checking Redis Configuration ===');
  
  console.log(`Redis Host: ${config.redis.host}`);
  console.log(`Redis Port: ${config.redis.port}`);
  console.log(`Redis DB: ${config.redis.db}`);
  console.log(`Redis Password: ${config.redis.password ? 'SET' : 'NOT SET'}`);

  try {
    // Check Redis connection via queue
    const queueHealth = await ocrQueue.getHealth();
    console.log(`Redis connection: ✅ Connected`);
    console.log(`Queue name: ${config.ocr.queueName}`);
    
    // Check queue stats
    const waiting = await ocrQueue.getWaitingCount();
    const active = await ocrQueue.getActiveCount();
    const completed = await ocrQueue.getCompletedCount();
    const failed = await ocrQueue.getFailedCount();
    
    console.log(`Queue stats:`);
    console.log(`  Waiting: ${waiting}`);
    console.log(`  Active: ${active}`);
    console.log(`  Completed: ${completed}`);
    console.log(`  Failed: ${failed}`);
    
    return true;
  } catch (error: any) {
    console.error(`❌ Redis Error: ${error.message}`);
    console.log(`\n⚠️  Make sure Redis is running and the worker is started with: npm run worker`);
    return false;
  }
}

async function checkTogetherAI() {
  console.log('\n=== Checking Together AI Configuration ===');
  
  console.log(`Together AI API Key: ${config.togetherAI.apiKey ? `${config.togetherAI.apiKey.substring(0, 8)}...` : 'NOT SET'}`);
  console.log(`Together AI Model: ${config.togetherAI.modelVision}`);
  console.log(`Together AI Base URL: ${config.togetherAI.baseUrl}`);
  console.log(`OCR Disabled: ${config.ocr.disableOcr ? '✅ YES (OCR is disabled)' : '❌ NO (OCR is enabled)'}`);

  if (config.ocr.disableOcr) {
    console.log('\n⚠️  OCR is disabled. Set DISABLE_OCR=false in .env to enable OCR processing.');
    return false;
  }

  if (!config.togetherAI.apiKey) {
    console.log('\n❌ Together AI API key is not set. Set TOGETHER_AI_API_KEY in .env');
    return false;
  }

  return true;
}

async function checkRecentJobs() {
  console.log('\n=== Checking Recent OCR Jobs ===');
  
  try {
    // Get recent OCR jobs
    const recentJobs = await OcrJob.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('receiptId')
      .exec();

    console.log(`Total recent jobs found: ${recentJobs.length}`);

    if (recentJobs.length === 0) {
      console.log('⚠️  No OCR jobs found. This might mean:');
      console.log('  1. No receipts have been uploaded yet');
      console.log('  2. OCR worker is not running');
      console.log('  3. Jobs are failing to be created');
      return;
    }

    console.log('\nRecent OCR Jobs:');
    recentJobs.forEach((job, idx) => {
      const receipt = job.receiptId as any;
      console.log(`\n${idx + 1}. Job ID: ${job._id}`);
      console.log(`   Status: ${job.status}`);
      console.log(`   Receipt ID: ${receipt?._id || 'N/A'}`);
      console.log(`   Created: ${job.createdAt}`);
      console.log(`   Attempts: ${job.attempts || 0}`);
      if (job.status === 'COMPLETED' && job.result) {
        console.log(`   Result: ✅ Success`);
        const result = job.result as any;
        if (result.vendor) console.log(`      Vendor: ${result.vendor}`);
        if (result.totalAmount) console.log(`      Amount: ${result.totalAmount}`);
        if (result.date) console.log(`      Date: ${result.date}`);
      } else if (job.status === 'FAILED') {
        console.log(`   Error: ❌ ${job.error || 'Unknown error'}`);
      } else if (job.status === 'PROCESSING') {
        console.log(`   Status: ⏳ Currently processing...`);
      } else if (job.status === 'QUEUED') {
        console.log(`   Status: ⏳ Queued (waiting for worker)`);
      }
    });

    // Check for receipts with OCR jobs
    const receiptsWithOcr = await Receipt.find({ ocrJobId: { $exists: true } })
      .limit(5)
      .populate('ocrJobId')
      .exec();

    console.log(`\nReceipts with OCR jobs: ${receiptsWithOcr.length}`);
    receiptsWithOcr.forEach((receipt, idx) => {
      const ocrJob = receipt.ocrJobId as any;
      console.log(`\n${idx + 1}. Receipt ID: ${receipt._id}`);
      console.log(`   Storage Key: ${receipt.storageKey}`);
      console.log(`   Upload Confirmed: ${receipt.uploadConfirmed ? '✅' : '❌'}`);
      console.log(`   OCR Job Status: ${ocrJob?.status || 'N/A'}`);
      if (receipt.parsedData) {
        console.log(`   Parsed Data: ✅ Available`);
      }
    });

  } catch (error: any) {
    console.error(`❌ Error checking jobs: ${error.message}`);
  }
}

async function main() {
  console.log('🔍 OCR and S3 Diagnostic Check\n');
  console.log('='.repeat(50));

  try {
    // Connect to MongoDB
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // Run checks
    const s3Ok = await checkS3();
    const redisOk = await checkRedis();
    const togetherAIOk = await checkTogetherAI();
    await checkRecentJobs();

    console.log('\n' + '='.repeat(50));
    console.log('\n📊 Summary:');
    console.log(`S3: ${s3Ok ? '✅ OK' : '❌ ISSUES'}`);
    console.log(`Redis: ${redisOk ? '✅ OK' : '❌ ISSUES'}`);
    console.log(`Together AI: ${togetherAIOk ? '✅ OK' : '❌ ISSUES'}`);

    if (!s3Ok) {
      console.log('\n⚠️  S3 Issues:');
      console.log('   - Check AWS credentials in .env');
      console.log('   - Verify bucket exists and has correct permissions');
      console.log('   - Ensure AWS_REGION is set correctly');
    }

    if (!redisOk) {
      console.log('\n⚠️  Redis Issues:');
      console.log('   - Make sure Redis is running: redis-server');
      console.log('   - Check REDIS_HOST, REDIS_PORT in .env');
      console.log('   - Start the OCR worker: npm run worker');
    }

    if (!togetherAIOk) {
      console.log('\n⚠️  Together AI Issues:');
      console.log('   - Set TOGETHER_AI_API_KEY in .env');
      console.log('   - Set DISABLE_OCR=false to enable OCR');
      console.log('   - Verify model name is correct');
    }

    console.log('\n✅ Diagnostic check complete!\n');

  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main();


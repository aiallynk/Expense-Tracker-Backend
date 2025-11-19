#!/usr/bin/env ts-node
/**
 * Setup script to create S3 buckets for the expense tracker application
 * 
 * Usage:
 *   npm run setup:s3
 *   or
 *   ts-node scripts/setup-s3-buckets.ts
 */

import dotenv from 'dotenv';
import { S3Client, CreateBucketCommand, HeadBucketCommand, BucketLocationConstraint } from '@aws-sdk/client-s3';
import { config } from '../src/config/index';

dotenv.config();

const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

async function bucketExists(bucketName: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function createBucket(bucketName: string): Promise<void> {
  const region = config.aws.region;
  
  try {
    const exists = await bucketExists(bucketName);
    if (exists) {
      console.log(`✅ Bucket "${bucketName}" already exists`);
      return;
    }

    console.log(`Creating bucket "${bucketName}" in region "${region}"...`);
    
    const createCommand = new CreateBucketCommand({
      Bucket: bucketName,
      ...(region !== 'us-east-1' && { 
        CreateBucketConfiguration: { 
          LocationConstraint: region as BucketLocationConstraint 
        } 
      }),
    });

    await s3Client.send(createCommand);
    console.log(`✅ Successfully created bucket "${bucketName}"`);
  } catch (error: any) {
    if (error.name === 'BucketAlreadyExists' || error.name === 'BucketAlreadyOwnedByYou') {
      console.log(`✅ Bucket "${bucketName}" already exists (created by another process)`);
      return;
    }
    
    console.error(`❌ Failed to create bucket "${bucketName}":`, error.message);
    throw error;
  }
}

async function main() {
  console.log('🚀 Setting up S3 bucket for Expense Tracker...\n');

  // Check AWS credentials
  if (!config.aws.accessKeyId || !config.aws.secretAccessKey) {
    console.error('❌ AWS credentials not configured!');
    console.error('Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your .env file');
    process.exit(1);
  }

  console.log(`Region: ${config.aws.region}`);
  console.log(`Bucket name: ${config.aws.s3BucketName}`);
  console.log('Note: This single bucket will store both receipts and exports (organized by folders)\n');

  try {
    await createBucket(config.aws.s3BucketName);
    
    console.log('\n✅ Bucket is ready!');
    console.log('📁 Files will be organized as:');
    console.log(`   - Receipts: s3://${config.aws.s3BucketName}/receipts/`);
    console.log(`   - Exports: s3://${config.aws.s3BucketName}/exports/`);
  } catch (error: any) {
    console.error('\n❌ Setup failed:', error.message);
    console.error('\n💡 Manual setup instructions:');
    console.error('1. Go to AWS S3 Console: https://s3.console.aws.amazon.com/');
    console.error('2. Click "Create bucket"');
    console.error(`3. Bucket name: ${config.aws.s3BucketName}`);
    console.error(`4. Region: ${config.aws.region}`);
    console.error('5. Leave other settings as default and create');
    process.exit(1);
  }
}

main().catch(console.error);


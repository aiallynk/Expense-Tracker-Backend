/**
 * Script to configure S3 bucket CORS for presigned URL uploads
 * Run: tsx scripts/setup-s3-cors.ts
 */

import { s3Client, getS3Bucket } from '../src/config/aws';
import { PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { config } from '../src/config/index';

async function setupS3CORS() {
  const bucket = getS3Bucket('receipts');
  
  console.log('Configuring CORS for S3 bucket:', bucket);
  console.log('Frontend URL:', config.app.frontendUrlApp);

  const corsConfiguration = {
    CORSRules: [
      {
        AllowedHeaders: ['*'],
        AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
        AllowedOrigins: [
          config.app.frontendUrlApp,
          config.app.frontendUrlAdmin,
          'http://localhost:5173', // Vite dev server
          'http://localhost:3000', // Common React dev port
          'http://localhost:5174', // Alternative Vite port
        ],
        ExposeHeaders: ['ETag', 'x-amz-server-side-encryption', 'x-amz-request-id', 'x-amz-id-2'],
        MaxAgeSeconds: 3600,
      },
    ],
  };

  try {
    const command = new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: corsConfiguration,
    });

    await s3Client.send(command);
    console.log('✅ CORS configuration applied successfully!');
    console.log('\nCORS Rules:');
    corsConfiguration.CORSRules.forEach((rule, index) => {
      console.log(`\nRule ${index + 1}:`);
      console.log(`  Allowed Origins: ${rule.AllowedOrigins.join(', ')}`);
      console.log(`  Allowed Methods: ${rule.AllowedMethods.join(', ')}`);
      console.log(`  Allowed Headers: ${rule.AllowedHeaders.join(', ')}`);
    });
  } catch (error: any) {
    console.error('❌ Failed to configure CORS:', error.message);
    
    if (error.name === 'AccessDenied' || error.$metadata?.httpStatusCode === 403) {
      console.error('\n⚠️  Access denied. You need S3 bucket CORS permissions.');
      console.error('Required IAM permission: s3:PutBucketCORS');
      console.error('\nYou can also configure CORS manually in AWS Console:');
      console.error(`1. Go to: https://s3.console.aws.amazon.com/s3/buckets/${bucket}?region=${config.aws.region}&tab=permissions`);
      console.error('2. Click "Edit" under Cross-origin resource sharing (CORS)');
      console.error('3. Paste the following JSON:');
      console.error('\n' + JSON.stringify(corsConfiguration, null, 2));
    } else {
      throw error;
    }
  }
}

setupS3CORS()
  .then(() => {
    console.log('\n✅ CORS setup complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Error:', error);
    process.exit(1);
  });


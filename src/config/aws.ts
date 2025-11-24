import { S3Client } from '@aws-sdk/client-s3';

import { config } from './index';

export const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

export const getS3Bucket = (_bucketType?: 'receipts' | 'exports' | 'backups'): string => {
  // Single bucket for receipts, exports, and backups
  // Files are organized by prefix: receipts/, exports/, and backups/
  // bucketType parameter is kept for API compatibility but not used
  return config.aws.s3BucketName;
};


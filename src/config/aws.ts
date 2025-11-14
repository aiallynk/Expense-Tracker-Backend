import { S3Client } from '@aws-sdk/client-s3';
import { config } from './index';

export const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

export const getS3Bucket = (bucketType: 'receipts' | 'exports'): string => {
  return bucketType === 'receipts'
    ? config.aws.s3Buckets.receipts
    : config.aws.s3Buckets.exports;
};


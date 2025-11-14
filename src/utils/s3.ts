import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, getS3Bucket } from '../config/aws';

export interface PresignedUploadUrlOptions {
  bucketType: 'receipts' | 'exports';
  key: string;
  mimeType: string;
  expiresIn?: number; // seconds
}

export const getPresignedUploadUrl = async (
  options: PresignedUploadUrlOptions
): Promise<string> => {
  const bucket = getS3Bucket(options.bucketType);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: options.key,
    ContentType: options.mimeType,
  });

  const expiresIn = options.expiresIn || 3600; // 1 hour default
  const url = await getSignedUrl(s3Client, command, { expiresIn });
  return url;
};

export const getPresignedDownloadUrl = async (
  bucketType: 'receipts' | 'exports',
  key: string,
  expiresIn: number = 3600
): Promise<string> => {
  const bucket = getS3Bucket(bucketType);
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn });
  return url;
};

export const getObjectUrl = (bucketType: 'receipts' | 'exports', key: string): string => {
  const bucket = getS3Bucket(bucketType);
  const region = process.env.AWS_REGION || 'ap-south-1';
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
};


import { PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand, BucketLocationConstraint } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, getS3Bucket } from '../config/aws';
import { config } from '../config/index';

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

/**
 * Check if an S3 bucket exists
 */
export const bucketExists = async (bucketName: string): Promise<boolean> => {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    return true;
  } catch (error: any) {
    // Handle different error types
    const statusCode = error.$metadata?.httpStatusCode;
    const errorName = error.name || error.Code;
    
    // Bucket doesn't exist
    if (statusCode === 404 || errorName === 'NotFound' || errorName === 'NoSuchBucket') {
      return false;
    }
    
    // Access denied - bucket might exist but we don't have permission to check
    if (statusCode === 403 || errorName === 'Forbidden' || errorName === 'AccessDenied') {
      // Assume bucket exists if we get access denied (common when bucket exists in another account)
      // But log a warning
      console.warn(`Access denied checking bucket "${bucketName}". Assuming it exists.`);
      return true;
    }
    
    // Re-throw other errors (network, etc.) with more context
    throw new Error(
      `Error checking bucket existence: ${errorName || 'Unknown'}. ` +
      `Status: ${statusCode || 'N/A'}. ` +
      `Message: ${error.message || error.Message || 'No message'}`
    );
  }
};

/**
 * Ensure an S3 bucket exists, create it if it doesn't
 * Note: Bucket creation may fail due to permissions or naming conflicts
 */
export const ensureBucketExists = async (bucketType: 'receipts' | 'exports'): Promise<void> => {
  // Single bucket for both types, so bucketType is ignored
  const bucket = getS3Bucket(bucketType);
  const region = config.aws.region;

  try {
    const exists = await bucketExists(bucket);
    if (exists) {
      console.log(`✅ S3 bucket "${bucket}" already exists`);
      return;
    }

    console.log(`Creating S3 bucket "${bucket}" in region "${region}"...`);
    
    // Try to create the bucket
    const createCommand = new CreateBucketCommand({
      Bucket: bucket,
      ...(region !== 'us-east-1' && { 
        CreateBucketConfiguration: { 
          LocationConstraint: region as BucketLocationConstraint 
        } 
      }),
    });

    await s3Client.send(createCommand);
    console.log(`✅ Created S3 bucket: ${bucket} in region ${region}`);
  } catch (error: any) {
    const errorName = error.name || error.Code || 'UnknownError';
    const statusCode = error.$metadata?.httpStatusCode;
    const errorMessage = error.message || error.Message || 'Unknown error';
    
    // Bucket already exists (created by another process or concurrent request)
    if (
      errorName === 'BucketAlreadyExists' || 
      errorName === 'BucketAlreadyOwnedByYou' ||
      statusCode === 409
    ) {
      console.log(`✅ S3 bucket "${bucket}" already exists (created by another process)`);
      return;
    }
    
    // Access denied - likely permissions issue
    if (statusCode === 403 || errorName === 'Forbidden' || errorName === 'AccessDenied') {
      throw new Error(
        `Access denied when creating S3 bucket "${bucket}". ` +
        `Please check your AWS credentials and IAM permissions. ` +
        `Required permissions: s3:CreateBucket, s3:PutObject, s3:GetObject. ` +
        `Bucket: ${bucket}, Region: ${region}`
      );
    }
    
    // Invalid credentials
    if (statusCode === 403 || errorName === 'InvalidAccessKeyId' || errorName === 'SignatureDoesNotMatch') {
      throw new Error(
        `Invalid AWS credentials. Please check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your .env file. ` +
        `Error: ${errorMessage}`
      );
    }
    
    // Provide detailed error message
    throw new Error(
      `Failed to create S3 bucket "${bucket}". ` +
      `Error: ${errorName} (${statusCode || 'N/A'}). ` +
      `Message: ${errorMessage}. ` +
      `Bucket: ${bucket}, Region: ${region}. ` +
      `Please create it manually in AWS Console or check your AWS credentials.`
    );
  }
};


# S3 CORS Configuration Setup

## Problem
When uploading files directly to S3 from the browser (using presigned URLs), you may encounter CORS errors if the S3 bucket is not properly configured.

## Solution
Apply the CORS configuration from `s3-cors-config.json` to your S3 bucket.

## Method 1: Using AWS Console

1. Go to AWS S3 Console: https://s3.console.aws.amazon.com/
2. Select your bucket (the one specified in `AWS_S3_BUCKET_NAME` environment variable)
3. Go to the **Permissions** tab
4. Scroll down to **Cross-origin resource sharing (CORS)**
5. Click **Edit**
6. Paste the contents of `s3-cors-config.json` (remove the outer array brackets `[]`)
7. Click **Save changes**

## Method 2: Using AWS CLI

```bash
# Make sure you have AWS CLI installed and configured
aws s3api put-bucket-cors \
  --bucket YOUR_BUCKET_NAME \
  --cors-configuration file://s3-cors-config.json
```

Replace `YOUR_BUCKET_NAME` with your actual S3 bucket name.

## Method 3: Using AWS SDK (Programmatic)

You can also apply this programmatically using the AWS SDK. Here's a Node.js example:

```javascript
const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const s3Client = new S3Client({
  region: 'ap-south-1', // Your region
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const corsConfig = JSON.parse(fs.readFileSync('s3-cors-config.json', 'utf8'));

async function applyCorsConfig() {
  try {
    const command = new PutBucketCorsCommand({
      Bucket: process.env.AWS_S3_BUCKET_NAME,
      CORSConfiguration: {
        CORSRules: corsConfig,
      },
    });
    
    await s3Client.send(command);
    console.log('CORS configuration applied successfully!');
  } catch (error) {
    console.error('Error applying CORS configuration:', error);
  }
}

applyCorsConfig();
```

## Important Notes

1. **Allowed Origins**: Make sure your production domain (`https://nexpense-aially.vercel.app`) is in the `AllowedOrigins` list
2. **Allowed Methods**: The config includes `PUT` which is required for presigned URL uploads
3. **Allowed Headers**: The config allows all headers (`*`) which should cover all necessary headers
4. **After applying**: Changes may take a few seconds to propagate

## Verification

After applying the CORS configuration, test the upload functionality. If you still see CORS errors:

1. Check that your domain is in the `AllowedOrigins` list
2. Verify the bucket name is correct
3. Wait a few seconds for changes to propagate
4. Clear browser cache and try again

## Troubleshooting

If you continue to experience CORS issues:

1. **Check browser console** for the exact error message
2. **Verify the origin** - Make sure the domain in the error matches one in `AllowedOrigins`
3. **Check bucket policy** - Ensure the bucket policy allows the necessary operations
4. **Verify presigned URL** - Make sure the presigned URL is generated correctly

## Current Configuration

The current `s3-cors-config.json` allows:
- **Origins**: Vercel production domain and localhost ports
- **Methods**: GET, PUT, POST, HEAD, DELETE
- **Headers**: All headers (including Content-Type and AWS-specific headers)
- **Max Age**: 3600 seconds (1 hour)


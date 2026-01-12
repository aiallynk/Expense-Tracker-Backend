# Quick Fix for S3 CORS Error

## Problem
You're getting CORS errors when uploading files to S3 from `https://nexpense-aially.vercel.app`

## Solution: Apply CORS Configuration to S3 Bucket

### Option 1: Run the Setup Script (Recommended)

From the `BACKEND` directory, run:

```bash
npm run setup:s3-cors
```

Or if that script doesn't exist:

```bash
npx tsx scripts/setup-s3-cors.ts
```

### Option 2: Manual Setup via AWS Console

1. Go to AWS S3 Console: https://s3.console.aws.amazon.com/
2. Find your bucket: `expense-tracker-aially`
3. Click on the bucket name
4. Go to the **Permissions** tab
5. Scroll down to **Cross-origin resource sharing (CORS)**
6. Click **Edit**
7. Paste the following JSON (remove the outer array brackets `[]`):

```json
{
  "AllowedHeaders": [
    "*",
    "Content-Type",
    "Content-Length",
    "x-amz-content-sha256",
    "x-amz-date",
    "x-amz-security-token",
    "x-amz-checksum-crc32",
    "x-amz-sdk-checksum-algorithm"
  ],
  "AllowedMethods": ["GET", "PUT", "POST", "HEAD", "DELETE"],
  "AllowedOrigins": [
    "https://nexpense-aially.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:5174",
    "http://localhost:5175"
  ],
  "ExposeHeaders": [
    "ETag",
    "x-amz-server-side-encryption",
    "x-amz-request-id",
    "x-amz-id-2",
    "x-amz-version-id"
  ],
  "MaxAgeSeconds": 3600
}
```

8. Click **Save changes**
9. Wait 10-30 seconds for changes to propagate
10. Try uploading again

### Option 3: Using AWS CLI

```bash
aws s3api put-bucket-cors \
  --bucket expense-tracker-aially \
  --cors-configuration file://s3-cors-config.json
```

**Note:** The `s3-cors-config.json` file has an outer array `[]`, but AWS expects just the object `{}`. You'll need to remove the brackets or use the JSON above.

## Verification

After applying:
1. Wait 10-30 seconds
2. Clear browser cache (Ctrl+Shift+Delete)
3. Try uploading a file again
4. Check browser console - CORS errors should be gone

## If Still Not Working

1. Verify the bucket name matches exactly: `expense-tracker-aially`
2. Check that `https://nexpense-aially.vercel.app` is in AllowedOrigins (no trailing slash)
3. Ensure PUT method is included in AllowedMethods
4. Check AWS IAM permissions - you need `s3:PutBucketCORS` permission

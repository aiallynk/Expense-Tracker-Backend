# S3 CORS Configuration

## Problem
When uploading files directly to S3 using presigned URLs, you may encounter CORS errors:
```
Access to fetch at 'https://bucket.s3.region.amazonaws.com/...' from origin 'http://localhost:5173' 
has been blocked by CORS policy
```

## Solution

### Option 1: Automatic Setup (Recommended)

Run the setup script:

```bash
cd BACKEND
npm run setup:s3-cors
```

This will configure CORS on your S3 bucket to allow uploads from:
- Your frontend URLs (from .env)
- Common localhost ports (5173, 3000, 5174)

### Option 2: Manual Setup via AWS Console

1. Go to AWS S3 Console: https://s3.console.aws.amazon.com/
2. Select your bucket: `expense-tracker-aially`
3. Go to **Permissions** tab
4. Scroll to **Cross-origin resource sharing (CORS)**
5. Click **Edit**
6. Paste the following JSON:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedOrigins": [
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:5174",
      "http://localhost:5175"
    ],
    "ExposeHeaders": [
      "ETag",
      "x-amz-server-side-encryption",
      "x-amz-request-id",
      "x-amz-id-2"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

7. Click **Save changes**

### Option 3: Update .env and Re-run Script

If your frontend runs on a different port, update `.env`:

```env
APP_FRONTEND_URL_APP=http://localhost:5173
```

Then run: `npm run setup:s3-cors`

## Verify CORS is Working

After configuring CORS, try uploading a receipt again. The CORS error should be resolved.

## Troubleshooting

### Still getting CORS errors?

1. **Check bucket name**: Make sure the bucket name in `.env` matches your S3 bucket
2. **Check region**: Ensure `AWS_REGION` in `.env` matches your bucket's region
3. **Check IAM permissions**: Your AWS credentials need `s3:PutBucketCORS` permission
4. **Clear browser cache**: Sometimes browsers cache CORS preflight responses
5. **Check browser console**: Look for the exact CORS error message

### IAM Permissions Required

Your AWS user/role needs:
- `s3:PutBucketCORS` - To configure CORS
- `s3:GetBucketCORS` - To read CORS config
- `s3:PutObject` - To upload files
- `s3:GetObject` - To download files


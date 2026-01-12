# IAM Policy Update - Add s3:PutBucketCORS Permission

## Problem
The IAM user `expense-tracker-admin` is missing the `s3:PutBucketCORS` permission needed to configure CORS on the S3 bucket.

## Solution: Update IAM Policy

### Option 1: Add Permission via AWS Console (Recommended)

1. Go to AWS IAM Console: https://console.aws.amazon.com/iam/
2. Click **Users** in the left sidebar
3. Find and click on the user: `expense-tracker-admin`
4. Click on the **Permissions** tab
5. Find the policy attached to this user (likely an inline policy or managed policy)
6. Click **Edit** on the policy
7. Add the following action to the policy's `Action` array:

```json
"s3:PutBucketCORS"
```

**Complete IAM Policy Example** (with all necessary S3 permissions):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:PutBucketCORS",
        "s3:GetBucketCORS",
        "s3:CreateBucket",
        "s3:HeadBucket"
      ],
      "Resource": [
        "arn:aws:s3:::expense-tracker-aially",
        "arn:aws:s3:::expense-tracker-aially/*"
      ]
    }
  ]
}
```

8. Click **Save changes**
9. Wait a few seconds for changes to propagate
10. Run the CORS setup script again: `npm run setup:s3-cors`

### Option 2: Create/Update Inline Policy via AWS CLI

If you prefer using AWS CLI:

```bash
aws iam put-user-policy \
  --user-name expense-tracker-admin \
  --policy-name S3BucketCORS \
  --policy-document file://iam-policy.json
```

Where `iam-policy.json` contains the complete policy above.

### Option 3: Manual CORS Configuration (No IAM Changes Needed)

Since you don't have `s3:PutBucketCORS` permission, you can configure CORS manually via AWS Console:

1. Go to: https://s3.console.aws.amazon.com/s3/buckets/expense-tracker-aially?region=ap-south-1&tab=permissions
2. Scroll down to **Cross-origin resource sharing (CORS)**
3. Click **Edit**
4. Paste the following JSON:

```json
[
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
]
```

5. Click **Save changes**
6. Wait 10-30 seconds for changes to propagate
7. Test file upload again

## Verification

After adding the permission or manually configuring CORS:

1. Wait 10-30 seconds
2. Clear browser cache
3. Try uploading a file
4. Check browser console - CORS errors should be resolved

## Current IAM User

- **User ARN**: `arn:aws:iam::814147157248:user/expense-tracker-admin`
- **Missing Permission**: `s3:PutBucketCORS`
- **Bucket**: `expense-tracker-aially`

## Recommended: Complete S3 IAM Policy

For full functionality, your IAM user should have these S3 permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:PutBucketCORS",
        "s3:GetBucketCORS",
        "s3:CreateBucket",
        "s3:HeadBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::expense-tracker-aially",
        "arn:aws:s3:::expense-tracker-aially/*"
      ]
    }
  ]
}
```

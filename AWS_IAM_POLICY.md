# AWS IAM Policy for Expense Tracker

## Required Permissions

The IAM user/role used by the application needs the following S3 permissions for the bucket `expense-tracker-aially`:

### Minimum Required Policy

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
        "s3:PutObjectAcl"
      ],
      "Resource": [
        "arn:aws:s3:::expense-tracker-aially/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::expense-tracker-aially"
      ]
    }
  ]
}
```

### Detailed Permissions Explained

- **s3:PutObject** - Required to upload receipt images and export files
- **s3:GetObject** - Required to download files (for OCR processing, viewing receipts)
- **s3:DeleteObject** - Optional: Required if you want to delete receipts/exports
- **s3:PutObjectAcl** - Optional: Required if you need to set ACLs on objects
- **s3:ListBucket** - Optional: Useful for debugging and listing files
- **s3:GetBucketLocation** - Optional: Useful for bucket operations

## How to Attach the Policy

### Option 1: Attach Policy to IAM User (Recommended for Development)

1. Go to [AWS IAM Console](https://console.aws.amazon.com/iam/)
2. Click on **Users** → Select `expense-tracker-admin`
3. Click on **Add permissions** → **Attach policies directly**
4. Click **Create policy**
5. Go to **JSON** tab and paste the policy above
6. Name it: `ExpenseTrackerS3Policy`
7. Click **Create policy**
8. Go back to the user and attach the newly created policy

### Option 2: Inline Policy (Quick Setup)

1. Go to [AWS IAM Console](https://console.aws.amazon.com/iam/)
2. Click on **Users** → Select `expense-tracker-admin`
3. Click on **Add permissions** → **Create inline policy**
4. Go to **JSON** tab and paste the policy above
5. Name it: `ExpenseTrackerS3InlinePolicy`
6. Click **Create policy**

### Option 3: Bucket Policy (Alternative)

You can also attach a bucket policy directly to the S3 bucket:

1. Go to [AWS S3 Console](https://s3.console.aws.amazon.com/)
2. Select bucket `expense-tracker-aially`
3. Go to **Permissions** tab
4. Scroll to **Bucket policy** and click **Edit**
5. Add the following policy (replace `814147157248` with your AWS account ID):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowExpenseTrackerAdmin",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::814147157248:user/expense-tracker-admin"
      },
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::expense-tracker-aially/*"
    },
    {
      "Sid": "AllowListBucket",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::814147157248:user/expense-tracker-admin"
      },
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": "arn:aws:s3:::expense-tracker-aially"
    }
  ]
}
```

## Testing Permissions

After attaching the policy, test the permissions:

```bash
# Test upload (using AWS CLI)
aws s3 cp test.txt s3://expense-tracker-aially/receipts/test.txt --profile expense-tracker-admin

# Test download
aws s3 cp s3://expense-tracker-aially/receipts/test.txt test-download.txt --profile expense-tracker-admin
```

## Troubleshooting

### Error: AccessDenied for s3:PutObject
- **Solution**: Ensure the IAM policy includes `s3:PutObject` permission
- **Check**: Verify the policy is attached to the correct IAM user
- **Verify**: Confirm the bucket name matches exactly: `expense-tracker-aially`

### Error: AccessDenied for s3:GetObject
- **Solution**: Add `s3:GetObject` permission to the policy
- **Note**: Required for OCR service to download images from S3

### Error: InvalidAccessKeyId
- **Solution**: Check that `AWS_ACCESS_KEY_ID` in `.env` matches the IAM user's access key

### Error: SignatureDoesNotMatch
- **Solution**: Verify `AWS_SECRET_ACCESS_KEY` in `.env` is correct

## Security Best Practices

1. **Principle of Least Privilege**: Only grant the minimum permissions needed
2. **Use IAM Roles**: For production, consider using IAM roles instead of access keys
3. **Rotate Keys**: Regularly rotate access keys
4. **Monitor Access**: Enable CloudTrail to monitor S3 access
5. **Bucket Encryption**: Enable server-side encryption on the bucket

## Current Configuration

Based on the error message:
- **IAM User**: `expense-tracker-admin`
- **AWS Account**: `814147157248`
- **Bucket**: `expense-tracker-aially`
- **Region**: `ap-south-1` (based on your .env)

Make sure the IAM user has the permissions listed above.


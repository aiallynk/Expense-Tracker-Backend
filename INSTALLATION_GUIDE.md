# Enterprise Backup System - Installation Guide

## Quick Start

### 1. Install Dependencies

```bash
cd BACKEND
npm install archiver adm-zip
npm install --save-dev @types/archiver @types/adm-zip
```

### 2. Configure Environment Variables

Add to `BACKEND/.env`:

```env
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here
AWS_REGION=ap-south-1
AWS_S3_BUCKET_NAME=your-bucket-name
```

### 3. Set Up S3 Bucket

1. **Create S3 Bucket**:
   - Name: Your bucket name (e.g., `expense-tracker-backups`)
   - Region: Same as `AWS_REGION`
   - Block all public access: **Enabled**

2. **Enable Encryption**:
   - Server-side encryption: **AES-256** (default)
   - Or use KMS for additional security

3. **Configure IAM Policy**:
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
           "s3:ListBucket"
         ],
         "Resource": [
           "arn:aws:s3:::your-bucket-name/*",
           "arn:aws:s3:::your-bucket-name"
         ]
       }
     ]
   }
   ```

### 4. Verify Installation

1. Start backend server
2. Navigate to Super Admin → Backup & Restore
3. Try creating a test backup
4. Check S3 bucket for uploaded file

## Testing

### Test Full Backup
1. Go to Backup & Restore page
2. Select "Full System"
3. Enter optional backup name
4. Click "Create Backup"
5. Wait for completion notification
6. Verify in S3: `s3://bucket/full-backups/backup_*.zip`

### Test Company Backup
1. Select "Specific Company"
2. Choose a company from dropdown
3. Enter optional backup name
4. Click "Create Backup"
5. Verify in S3: `s3://bucket/company-backups/<companyId>/backup_*.zip`

### Test Restore (⚠️ TEST ENVIRONMENT ONLY)
1. Create a test backup
2. Click "Restore" on the backup
3. Review backup details
4. Type "RESTORE" in confirmation field
5. Click "Restore Backup"
6. Monitor progress via WebSocket updates

## Troubleshooting

### "archiver is not defined"
- Run: `npm install archiver @types/archiver`

### "adm-zip is not defined"
- Run: `npm install adm-zip @types/adm-zip`

### S3 Upload Fails
- Check AWS credentials in `.env`
- Verify bucket name is correct
- Check IAM permissions
- Verify bucket exists in correct region

### Restore Fails
- Ensure backup status is "completed"
- Check database connection
- Verify backup ZIP is not corrupted
- Review server logs for specific errors

## Production Checklist

- [ ] S3 bucket created and configured
- [ ] IAM credentials configured
- [ ] Encryption enabled (AES-256 or KMS)
- [ ] Public access blocked
- [ ] Backup tested successfully
- [ ] Restore tested (on staging)
- [ ] Audit logging verified
- [ ] Monitoring set up for S3 storage
- [ ] Backup retention policy defined
- [ ] Disaster recovery plan documented

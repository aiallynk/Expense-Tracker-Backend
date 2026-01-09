# Enterprise-Grade Backup & Restore System

## Overview

The backup system has been upgraded to enterprise-grade with AWS S3 storage, company-specific backups, manifest-based structure, and comprehensive safety features.

## Architecture

### Backup Types

1. **FULL SYSTEM BACKUP**
   - Includes: All companies, users, reports, expenses, OCR data, configurations
   - Access: SUPER_ADMIN only
   - Storage: `s3://<bucket>/full-backups/backup_YYYY-MM-DD_HH-mm-ss.zip`

2. **COMPANY-SPECIFIC BACKUP**
   - Includes: Only company data (isolated, no cross-company data)
   - Access: SUPER_ADMIN (can restore to any company)
   - Storage: `s3://<bucket>/company-backups/<companyId>/backup_YYYY-MM-DD_HH-mm-ss.zip`

### Backup Structure

Each backup is a ZIP file containing:

```
backup_YYYY-MM-DD_HH-mm-ss.zip
├── manifest.json          # Backup metadata and record counts
├── companies.json         # Company data
├── users.json            # User data
├── reports.json          # Expense reports
├── expenses.json         # Expense items
├── ocr.json             # OCR job data
├── receipts.json        # Receipt data
├── departments.json     # Department data
├── projects.json        # Project data
├── costCentres.json     # Cost centre data
└── companySettings.json  # Company settings
```

### Manifest Structure

```json
{
  "backupId": "507f1f77bcf86cd799439011",
  "backupType": "FULL" | "COMPANY",
  "companyId": "507f1f77bcf86cd799439012" (optional),
  "companyName": "Acme Corp" (optional),
  "createdAt": "2024-01-09T14:30:00.000Z",
  "createdBy": "507f1f77bcf86cd799439013",
  "createdByEmail": "admin@example.com",
  "recordCounts": {
    "companies": 25,
    "users": 1250,
    "reports": 3200,
    "expenses": 15420,
    "ocrJobs": 12000,
    "receipts": 12000,
    "departments": 150,
    "projects": 200,
    "costCentres": 100
  },
  "appVersion": "2.0.0"
}
```

## Security & Compliance

### Encryption
- **S3 Server-Side Encryption**: AES-256 (default)
- **Bucket**: Private, no public access
- **IAM**: Uses environment variables for credentials

### Access Control
- **Full Backup/Restore**: SUPER_ADMIN only
- **Company Backup**: SUPER_ADMIN only
- **Company Restore**: SUPER_ADMIN only (can restore to any company)

### Audit Logging
All backup/restore actions are logged:
- `BACKUP_CREATED`: When backup is created
- `BACKUP_RESTORED`: When backup is restored
- `BACKUP_DELETED`: When backup is deleted

## API Endpoints

### Create Full Backup
```
POST /api/v1/super-admin/backup/full
Body: { backupName?: string }
```

### Create Company Backup
```
POST /api/v1/super-admin/backup/company/:companyId
Body: { backupName?: string }
```

### List Backups
```
GET /api/v1/super-admin/backups?companyId=<optional>
```

### Restore Backup
```
POST /api/v1/super-admin/backups/:id/restore
Body: {
  confirmText: "RESTORE",  // Required: must type "RESTORE"
  restoreToCompanyId?: string  // For company backups: restore to different company
}
```

### Download Backup
```
GET /api/v1/super-admin/backups/:id/download
Returns: { downloadUrl: "https://..." }  // Presigned URL (1 hour expiry)
```

### Delete Backup
```
DELETE /api/v1/super-admin/backup/:id
```

## Restore Logic

### Full Restore
1. Validates backup manifest
2. Clears all collections (except system collections and backups)
3. Restores data in dependency order:
   - Companies → Departments → Projects → Cost Centres
   - Users → Company Settings
   - Receipts → OCR Jobs
   - Reports → Expenses

### Company Restore
1. Validates backup manifest and company ID
2. Deletes existing company data (soft-delete option available)
3. Restores with ID remapping:
   - Maps old company ID to target company ID
   - Maps old user IDs to new user IDs
   - Maps old department/project/cost centre IDs
   - Maps old receipt IDs
   - Maps old report IDs (for expense references)
   - Preserves foreign key relationships

### Safety Features
- **Confirmation Required**: Must type "RESTORE" to confirm
- **Role Check**: Only SUPER_ADMIN can restore
- **ID Remapping**: Prevents data duplication
- **Dependency Order**: Restores in correct order
- **Date Conversion**: Converts date strings to Date objects
- **Error Handling**: Comprehensive error logging

## Installation

### Required Packages

```bash
npm install archiver adm-zip
npm install --save-dev @types/archiver @types/adm-zip
```

### Environment Variables

```env
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=ap-south-1
AWS_S3_BUCKET_NAME=your-bucket-name
```

### S3 Bucket Setup

1. Create private S3 bucket
2. Enable server-side encryption (AES-256)
3. Block public access
4. Configure IAM policy for backup service

## UI Features

### Create Backup Section
- Backup type selection (Full System / Specific Company)
- Company selector (visible only for company backup)
- Backup name input (optional)
- Create button with validation

### Backup History Table
- Backup name / timestamp
- Type badge (Full System / Company)
- Company name (if applicable)
- Size
- Status with icon
- Created by
- Actions: Download, Restore, Delete

### Restore Confirmation
- Shows backup details (type, company, record counts)
- Warning message
- Type-to-confirm input (must type "RESTORE")
- Company selector (for company backups)
- Confirmation button

## Performance

- **Streaming**: Data is streamed to prevent memory overload
- **Background Jobs**: Backups run asynchronously
- **Progress Updates**: Real-time WebSocket updates
- **Retry Logic**: Failed uploads are retried
- **Validation**: Backup validated before restore

## Best Practices

1. **Regular Backups**: Create full backups daily
2. **Company Backups**: Create before major changes
3. **Test Restores**: Periodically test restore process
4. **Monitor Storage**: Track S3 storage usage
5. **Audit Review**: Regularly review audit logs
6. **Disaster Recovery**: Maintain off-site backups

## Migration Notes

- Existing backups (v1.0) will continue to work
- New backups use v2.0 format (ZIP + manifest)
- Old restore logic still supported for backward compatibility

## Troubleshooting

### Backup Fails
- Check S3 credentials and permissions
- Verify bucket exists and is accessible
- Check disk space for temp files
- Review logs for specific errors

### Restore Fails
- Verify backup is completed
- Check database connection
- Ensure sufficient disk space
- Review ID remapping logs

### Download Fails
- Check presigned URL expiry (1 hour)
- Verify S3 bucket permissions
- Check backup storage key exists

## Future Enhancements

- [ ] Scheduled automatic backups
- [ ] Incremental backups
- [ ] Backup retention policies
- [ ] Cross-region replication
- [ ] Backup compression optimization
- [ ] Restore preview mode
- [ ] Backup validation checksums

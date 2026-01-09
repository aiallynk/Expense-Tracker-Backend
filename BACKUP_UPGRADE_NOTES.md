# Backup System Upgrade - Installation Notes

## Required Packages

Install these packages for ZIP compression and extraction:
```bash
npm install archiver adm-zip
npm install --save-dev @types/archiver @types/adm-zip
```

## Environment Variables

Ensure these are set in `.env`:
```
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=ap-south-1
AWS_S3_BUCKET_NAME=your-bucket-name
```

## S3 Bucket Structure

The upgraded system uses this structure:
```
s3://<bucket-name>/
  ├── full-backups/
  │   └── backup_YYYY-MM-DD_HH-mm-ss.zip
  ├── company-backups/
  │   └── <companyId>/
  │       └── backup_YYYY-MM-DD_HH-mm-ss.zip
  └── metadata/
      └── backup-manifest.json (optional, also stored in ZIP)
```

## Migration

Existing backups will continue to work. New backups will use the new format.

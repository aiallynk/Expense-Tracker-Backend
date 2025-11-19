# Setup Guide

## Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp env.example .env
   # Edit .env with your actual credentials
   ```

3. **Run in Development**
   ```bash
   npm run dev
   ```

4. **Build for Production**
   ```bash
   npm run build
   npm start
   ```

## Environment Variables

All required environment variables are listed in `env.example`. Key ones:

- **MongoDB**: Connection string to your MongoDB Atlas or local instance
- **JWT Secrets**: Strong random strings (min 32 chars recommended)
- **AWS**: S3 bucket names and credentials
- **OpenAI**: API key for OCR functionality
- **Firebase**: Admin SDK credentials for push notifications
- **Resend**: API key for email notifications

### AWS S3 Bucket Setup

The application uses a single S3 bucket for both receipts and exports:
- `expense-tracker-aially` - Stores both receipt images and exported reports (organized by folders)

Files are organized within the bucket:
- Receipts: `s3://expense-tracker-aially/receipts/`
- Exports: `s3://expense-tracker-aially/exports/`

**Option 1: Automatic Setup (Recommended)**
```bash
npm run setup:s3
```

This script will automatically create the bucket if it doesn't exist. Make sure your AWS credentials are configured in `.env`:
```
AWS_REGION=ap-south-1
S3_BUCKET_NAME=expense-tracker-aially
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
```

**Option 2: Manual Setup**
1. Go to [AWS S3 Console](https://s3.console.aws.amazon.com/)
2. Click "Create bucket"
3. Bucket name: `expense-tracker-aially` (must match your `.env` file)
4. Region: Select your region (e.g., `ap-south-1`)
5. Leave other settings as default and create

**Note:** The application will automatically try to create the bucket if it doesn't exist when you upload a receipt, but it's recommended to create it beforehand using the setup script.

## Initial Setup

### Create Admin User

You'll need to create an admin user manually in MongoDB or via a script:

```javascript
// scripts/create-admin.js
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI);

const User = require('./src/models/User').User;

async function createAdmin() {
  const passwordHash = await bcrypt.hash('admin123', 10);
  const admin = new User({
    email: 'admin@example.com',
    passwordHash,
    name: 'Admin User',
    role: 'ADMIN',
    status: 'ACTIVE',
  });
  await admin.save();
  console.log('Admin user created');
  process.exit(0);
}

createAdmin();
```

### Seed Categories

Create default categories:

```javascript
// scripts/seed-categories.js
const Category = require('./src/models/Category').Category;

const categories = [
  { name: 'Travel', code: 'TRAVEL' },
  { name: 'Food', code: 'FOOD' },
  { name: 'Office', code: 'OFFICE' },
  { name: 'Others', code: 'OTHERS' },
];

async function seed() {
  for (const cat of categories) {
    await Category.findOneAndUpdate(
      { name: cat.name },
      cat,
      { upsert: true }
    );
  }
  console.log('Categories seeded');
  process.exit(0);
}

seed();
```

## Testing

```bash
npm test
```

## Docker

### Development
```bash
docker-compose up
```

### Production Build
```bash
docker build -t expense-tracker-backend .
docker run -p 4000:4000 --env-file .env expense-tracker-backend
```

## API Documentation

All endpoints are prefixed with `/api/v1`.

### Authentication
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/refresh` - Refresh token
- `POST /api/v1/auth/logout` - Logout

### Reports (Employee)
- `POST /api/v1/reports` - Create report
- `GET /api/v1/reports` - List reports
- `GET /api/v1/reports/:id` - Get report
- `PATCH /api/v1/reports/:id` - Update report
- `POST /api/v1/reports/:id/submit` - Submit report

### Expenses
- `POST /api/v1/reports/:reportId/expenses` - Add expense
- `GET /api/v1/expenses` - List expenses
- `GET /api/v1/expenses/:id` - Get expense
- `PATCH /api/v1/expenses/:id` - Update expense

### Receipts & OCR
- `POST /api/v1/expenses/:expenseId/receipts/upload-intent` - Get upload URL
- `POST /api/v1/receipts/:receiptId/confirm` - Confirm upload
- `GET /api/v1/receipts/:id` - Get receipt
- `GET /api/v1/ocr/jobs/:id` - Get OCR status

### Admin
- `GET /api/v1/admin/reports` - List all reports
- `POST /api/v1/admin/reports/:id/approve` - Approve report
- `POST /api/v1/admin/reports/:id/reject` - Reject report
- `GET /api/v1/admin/reports/:id/export` - Export report
- `GET /api/v1/admin/summary/dashboard` - Dashboard metrics

## Notes

- All protected routes require `Authorization: Bearer <token>` header
- Access tokens expire in 15 minutes
- Refresh tokens expire in 30 days
- Rate limiting is applied to sensitive endpoints
- Firebase is optional - app will continue without push notifications if not configured


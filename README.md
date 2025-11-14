# Expense Tracker Backend API

A complete Node.js backend for an Expense Scanner application with mobile (Flutter) and web (React) clients.

## Tech Stack

- **Runtime**: Node.js (LTS 18+)
- **Language**: TypeScript
- **Framework**: Express.js
- **Database**: MongoDB Atlas via Mongoose
- **Authentication**: JWT (access + refresh tokens)
- **Storage**: AWS S3 for receipts and exports
- **AI/OCR**: OpenAI GPT-4o Vision for receipt scanning
- **Notifications**: Firebase Cloud Messaging (FCM)
- **Email**: Resend for transactional emails

## Project Structure

```
src/
├── app.ts                 # Express app bootstrap
├── server.ts              # HTTP server entry point
├── config/                # Configuration files
│   ├── index.ts
│   ├── db.ts
│   ├── aws.ts
│   ├── openai.ts
│   ├── firebase.ts
│   └── resend.ts
├── models/                # Mongoose models
│   ├── User.ts
│   ├── Project.ts
│   ├── Category.ts
│   ├── ExpenseReport.ts
│   ├── Expense.ts
│   ├── Receipt.ts
│   ├── OcrJob.ts
│   ├── NotificationToken.ts
│   └── AuditLog.ts
├── routes/                # Express routes
│   ├── auth.routes.ts
│   ├── users.routes.ts
│   ├── projects.routes.ts
│   ├── categories.routes.ts
│   ├── reports.routes.ts
│   ├── expenses.routes.ts
│   ├── receipts.routes.ts
│   ├── ocr.routes.ts
│   └── admin.routes.ts
├── controllers/           # Route controllers
├── services/              # Business logic
├── middleware/            # Express middleware
│   ├── auth.middleware.ts
│   ├── role.middleware.ts
│   ├── validate.middleware.ts
│   ├── error.middleware.ts
│   └── rateLimit.middleware.ts
├── utils/                 # Utility functions
│   ├── logger.ts
│   ├── pagination.ts
│   ├── s3.ts
│   ├── enums.ts
│   └── dtoTypes.ts
└── jobs/                  # Background workers
    ├── ocr.worker.ts
    └── export.worker.ts
```

## Setup

### Prerequisites

- Node.js 18+ and npm
- MongoDB Atlas account (or local MongoDB)
- AWS account with S3 buckets
- OpenAI API key
- Firebase project with Admin SDK credentials
- Resend account

### Installation

1. Clone the repository and navigate to the backend folder:
```bash
cd BACKEND
```

2. Install dependencies:
```bash
npm install
```

3. Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

4. Update `.env` with your actual values:
   - MongoDB connection string
   - AWS credentials and bucket names
   - OpenAI API key
   - Firebase credentials
   - Resend API key
   - JWT secrets (use strong random strings)

### Running in Development

```bash
npm run dev
```

The server will start on `http://localhost:4000` (or the port specified in `.env`).

### Building for Production

```bash
npm run build
npm start
```

## Environment Variables

See `.env.example` for all required environment variables. Key variables:

- `MONGODB_URI`: MongoDB connection string
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`: JWT signing secrets
- `AWS_*`: AWS S3 configuration
- `OPENAI_API_KEY`: OpenAI API key for OCR
- `FIREBASE_*`: Firebase Admin SDK credentials
- `RESEND_API_KEY`: Resend API key for emails

## API Endpoints

### Authentication
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/refresh` - Refresh access token
- `POST /api/v1/auth/logout` - Logout

### Expense Reports (Employee)
- `POST /api/v1/reports` - Create report
- `GET /api/v1/reports` - List user's reports
- `GET /api/v1/reports/:id` - Get report details
- `PATCH /api/v1/reports/:id` - Update report (DRAFT only)
- `POST /api/v1/reports/:id/submit` - Submit report

### Expenses
- `POST /api/v1/reports/:reportId/expenses` - Add expense
- `PATCH /api/v1/expenses/:id` - Update expense
- `GET /api/v1/expenses/:id` - Get expense details
- `GET /api/v1/expenses` - List expenses

### Receipts & OCR
- `POST /api/v1/expenses/:expenseId/receipts/upload-intent` - Get presigned upload URL
- `POST /api/v1/receipts/:receiptId/confirm` - Confirm upload and trigger OCR
- `GET /api/v1/receipts/:id` - Get receipt
- `GET /api/v1/ocr/jobs/:id` - Get OCR job status

### Admin Endpoints
- `GET /api/v1/admin/reports` - List all reports
- `POST /api/v1/admin/reports/:id/approve` - Approve report
- `POST /api/v1/admin/reports/:id/reject` - Reject report
- `GET /api/v1/admin/reports/:id/export` - Export report
- `GET /api/v1/admin/expenses` - List all expenses
- `POST /api/v1/admin/expenses/:id/approve` - Approve expense
- `POST /api/v1/admin/expenses/:id/reject` - Reject expense
- `GET /api/v1/admin/summary/dashboard` - Dashboard metrics

### Projects & Categories
- `GET /api/v1/projects` - List projects
- `POST /api/v1/projects` - Create project (admin)
- `GET /api/v1/categories` - List categories
- `POST /api/v1/categories` - Create category (admin)

## Authentication

All protected endpoints require a JWT access token in the Authorization header:

```
Authorization: Bearer <access_token>
```

Access tokens expire in 15 minutes. Use the refresh token endpoint to get a new access token.

## User Roles

- **EMPLOYEE**: Can create and manage their own expense reports
- **ADMIN**: Can approve/reject reports, manage projects/categories, view all data
- **BUSINESS_HEAD**: Similar to ADMIN with additional analytics access

## State Machine

### ExpenseReport Status Flow
- `DRAFT` → `SUBMITTED` → `APPROVED` | `REJECTED`
- Draft reports are editable
- Submitted reports are locked except for approval actions

### Expense Status Flow
- `DRAFT` → `PENDING` → `APPROVED` | `REJECTED`

## Testing

```bash
npm test
```

## Docker

### Development
```bash
docker-compose up
```

### Production
```bash
docker build -t expense-tracker-backend .
docker run -p 4000:4000 --env-file .env expense-tracker-backend
```

## License

ISC


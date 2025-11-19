# BACKEND Folder - Detailed Overview

## Table of Contents
1. [Introduction](#introduction)
2. [Technology Stack](#technology-stack)
3. [Project Structure](#project-structure)
4. [Architecture & Design Patterns](#architecture--design-patterns)
5. [Core Components](#core-components)
6. [Data Flow](#data-flow)
7. [Authentication & Authorization](#authentication--authorization)
8. [API Endpoints](#api-endpoints)
9. [External Integrations](#external-integrations)
10. [Database Models](#database-models)
11. [Development Workflow](#development-workflow)
12. [Deployment](#deployment)

---

## Introduction

The **BACKEND** folder contains a complete Node.js backend API for an **Expense Tracker Application**. This backend serves both mobile (Flutter) and web (React) clients, providing a RESTful API for managing expense reports, receipts, OCR processing, user authentication, and administrative functions.

### Purpose
- **Expense Management**: Create, track, and manage expense reports and individual expenses
- **Receipt Processing**: Upload receipts and extract data using AI-powered OCR
- **User Management**: Authentication, authorization, and role-based access control
- **Administrative Functions**: Approve/reject expenses, generate reports, manage projects and categories
- **Notifications**: Push notifications via Firebase Cloud Messaging
- **Export Functionality**: Generate PDF, Excel, and CSV exports of expense reports

---

## Technology Stack

### Core Technologies
- **Runtime**: Node.js 18+ (LTS)
- **Language**: TypeScript 5.7+
- **Framework**: Express.js 4.21+
- **Database**: MongoDB (via Mongoose 8.9+)
- **Authentication**: JWT (JSON Web Tokens) with access and refresh tokens

### Key Dependencies
- **Security**: 
  - `helmet` - Security headers
  - `cors` - Cross-origin resource sharing
  - `bcrypt` - Password hashing
  - `express-rate-limit` - Rate limiting
- **Validation**: 
  - `joi` - Schema validation
  - `zod` - Type-safe validation
- **Storage**: 
  - `@aws-sdk/client-s3` - AWS S3 integration for file storage
- **AI/OCR**: 
  - `openai` - OpenAI GPT-4o Vision for receipt scanning
- **Notifications**: 
  - `firebase-admin` - Firebase Cloud Messaging
- **Email**: 
  - `resend` - Transactional email service
- **Export**: 
  - `pdfkit` - PDF generation
  - `exceljs` - Excel file generation

### Development Tools
- **TypeScript**: Type safety and modern JavaScript features
- **tsx**: TypeScript execution for development
- **Jest**: Testing framework
- **ESLint**: Code linting

---

## Project Structure

```
BACKEND/
├── src/                          # Source TypeScript files
│   ├── app.ts                   # Express app configuration
│   ├── server.ts                # HTTP server entry point
│   │
│   ├── config/                  # Configuration modules
│   │   ├── index.ts             # Main config aggregator
│   │   ├── db.ts                # MongoDB connection
│   │   ├── aws.ts               # AWS S3 configuration
│   │   ├── openai.ts            # OpenAI API configuration
│   │   ├── firebase.ts          # Firebase Admin SDK setup
│   │   └── resend.ts            # Resend email service config
│   │
│   ├── models/                  # Mongoose data models
│   │   ├── User.ts              # User model with authentication
│   │   ├── Project.ts           # Project model
│   │   ├── Category.ts          # Expense category model
│   │   ├── ExpenseReport.ts     # Expense report model
│   │   ├── Expense.ts           # Individual expense model
│   │   ├── Receipt.ts           # Receipt model
│   │   ├── OcrJob.ts            # OCR processing job model
│   │   ├── NotificationToken.ts # FCM device tokens
│   │   └── AuditLog.ts          # Audit trail model
│   │
│   ├── routes/                  # Express route definitions
│   │   ├── auth.routes.ts       # Authentication endpoints
│   │   ├── users.routes.ts      # User management
│   │   ├── projects.routes.ts   # Project CRUD
│   │   ├── categories.routes.ts  # Category CRUD
│   │   ├── reports.routes.ts    # Expense report endpoints
│   │   ├── expenses.routes.ts   # Expense endpoints
│   │   ├── receipts.routes.ts   # Receipt upload/management
│   │   ├── ocr.routes.ts        # OCR job status endpoints
│   │   ├── admin.routes.ts      # Admin-only endpoints
│   │   └── notifications.routes.ts # Notification endpoints
│   │
│   ├── controllers/             # Route controllers (request handlers)
│   │   ├── auth.controller.ts   # Auth logic (login, signup, refresh)
│   │   ├── users.controller.ts  # User management
│   │   ├── projects.controller.ts
│   │   ├── categories.controller.ts
│   │   ├── reports.controller.ts
│   │   ├── expenses.controller.ts
│   │   ├── receipts.controller.ts
│   │   ├── ocr.controller.ts
│   │   └── admin.controller.ts
│   │
│   ├── services/                # Business logic layer
│   │   ├── auth.service.ts      # Authentication service
│   │   ├── users.service.ts     # User operations
│   │   ├── projects.service.ts
│   │   ├── categories.service.ts
│   │   ├── reports.service.ts   # Report business logic
│   │   ├── expenses.service.ts
│   │   ├── receipts.service.ts  # Receipt management
│   │   ├── ocr.service.ts       # OCR processing logic
│   │   ├── export.service.ts    # PDF/Excel/CSV generation
│   │   ├── notification.service.ts # Push notifications
│   │   └── audit.service.ts     # Audit logging
│   │
│   ├── middleware/              # Express middleware
│   │   ├── auth.middleware.ts   # JWT authentication
│   │   ├── role.middleware.ts   # Role-based authorization
│   │   ├── validate.middleware.ts # Request validation
│   │   ├── error.middleware.ts  # Global error handler
│   │   └── rateLimit.middleware.ts # Rate limiting
│   │
│   ├── utils/                   # Utility functions
│   │   ├── logger.ts            # Logging utility
│   │   ├── pagination.ts        # Pagination helpers
│   │   ├── s3.ts                # S3 upload/download helpers
│   │   ├── enums.ts             # TypeScript enums
│   │   └── dtoTypes.ts          # Data Transfer Object types
│   │
│   ├── types/                   # TypeScript type definitions
│   │   └── pdfkit.d.ts          # PDFKit type extensions
│   │
│   └── __tests__/               # Test files
│       └── setup.ts             # Test configuration
│
├── dist/                        # Compiled JavaScript (generated)
├── node_modules/                # Dependencies
├── package.json                 # Dependencies and scripts
├── tsconfig.json                # TypeScript configuration
├── jest.config.js               # Jest test configuration
├── Dockerfile                   # Docker image definition
├── docker-compose.yml           # Docker Compose configuration
├── env.example                  # Environment variables template
├── README.md                    # Quick start guide
└── SETUP.md                     # Detailed setup instructions
```

---

## Architecture & Design Patterns

### Layered Architecture

The backend follows a **layered architecture** pattern:

```
┌─────────────────────────────────────┐
│         Routes Layer                │  ← HTTP endpoints, route definitions
├─────────────────────────────────────┤
│         Controllers Layer           │  ← Request/response handling
├─────────────────────────────────────┤
│         Services Layer              │  ← Business logic
├─────────────────────────────────────┤
│         Models Layer                │  ← Data models (Mongoose)
└─────────────────────────────────────┘
```

### Design Principles

1. **Separation of Concerns**: Each layer has a specific responsibility
2. **Dependency Injection**: Services are injected into controllers
3. **Middleware Pattern**: Cross-cutting concerns (auth, validation, errors) handled via middleware
4. **Repository Pattern**: Models abstract database operations
5. **Service Layer Pattern**: Business logic isolated from HTTP concerns

### Request Flow

```
HTTP Request
    ↓
Rate Limiter Middleware
    ↓
CORS & Security (Helmet)
    ↓
Route Handler
    ↓
Validation Middleware
    ↓
Authentication Middleware (if protected)
    ↓
Role Middleware (if role-specific)
    ↓
Controller
    ↓
Service (Business Logic)
    ↓
Model (Database)
    ↓
Response
    ↓
Error Middleware (if error occurs)
```

---

## Core Components

### 1. Configuration (`src/config/`)

Centralized configuration management using environment variables.

**Key Files:**
- **`index.ts`**: Aggregates all configuration from environment variables
- **`db.ts`**: MongoDB connection setup with error handling
- **`aws.ts`**: AWS S3 client configuration
- **`openai.ts`**: OpenAI API client setup
- **`firebase.ts`**: Firebase Admin SDK initialization
- **`resend.ts`**: Resend email service configuration

**Configuration Categories:**
- Application settings (port, environment, frontend URLs)
- Database connection (MongoDB URI)
- JWT secrets and expiration times
- AWS credentials and S3 bucket names
- OpenAI API key and model selection
- Firebase project credentials
- Resend email service credentials

### 2. Models (`src/models/`)

Mongoose schemas defining the data structure and relationships.

**Core Models:**

- **User**: User accounts with email, password hash, role, and status
- **ExpenseReport**: Expense reports with status workflow (DRAFT → SUBMITTED → APPROVED/REJECTED)
- **Expense**: Individual expenses linked to reports
- **Receipt**: Receipt images stored in S3 with OCR metadata
- **OcrJob**: Tracks OCR processing status and results
- **Project**: Projects that expenses can be associated with
- **Category**: Expense categories (e.g., Travel, Food, Accommodation)
- **NotificationToken**: FCM device tokens for push notifications
- **AuditLog**: Audit trail for important actions

**Features:**
- Automatic timestamps (`createdAt`, `updatedAt`)
- Indexes for query optimization
- Pre-save validation hooks
- Virtual fields and methods
- Population for related documents

### 3. Routes (`src/routes/`)

Express route definitions that map HTTP endpoints to controllers.

**Route Structure:**
- All routes prefixed with `/api/v1`
- Protected routes use `authMiddleware`
- Role-specific routes use `roleMiddleware`
- Validation middleware applied per route
- Rate limiting on sensitive endpoints (login, signup)

**Route Files:**
- `auth.routes.ts`: `/api/v1/auth/*` - Login, signup, refresh, logout
- `users.routes.ts`: `/api/v1/users/*` - User profile management
- `projects.routes.ts`: `/api/v1/projects/*` - Project CRUD
- `categories.routes.ts`: `/api/v1/categories/*` - Category CRUD
- `reports.routes.ts`: `/api/v1/reports/*` - Expense report management
- `expenses.routes.ts`: `/api/v1/expenses/*` - Expense CRUD
- `receipts.routes.ts`: `/api/v1/expenses/:id/receipts/*` - Receipt upload
- `ocr.routes.ts`: `/api/v1/ocr/jobs/:id` - OCR job status
- `admin.routes.ts`: `/api/v1/admin/*` - Admin-only endpoints
- `notifications.routes.ts`: `/api/v1/notifications/*` - Device token management

### 4. Controllers (`src/controllers/`)

Handle HTTP requests and responses, delegate to services.

**Responsibilities:**
- Extract data from request (body, params, query)
- Call appropriate service methods
- Format responses
- Handle errors and return appropriate status codes

**Controller Pattern:**
```typescript
export class ControllerName {
  static async action(req: Request, res: Response): Promise<void> {
    try {
      const result = await ServiceName.action(req.body);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      // Error handled by error middleware
      throw error;
    }
  }
}
```

### 5. Services (`src/services/`)

Business logic layer - the core of the application.

**Service Responsibilities:**
- Implement business rules
- Coordinate between multiple models
- Handle complex operations (e.g., OCR processing, report generation)
- Interact with external services (AWS, OpenAI, Firebase)
- Data transformation and validation

**Key Services:**

- **`auth.service.ts`**: 
  - User signup/login
  - JWT token generation and validation
  - Password hashing and verification

- **`reports.service.ts`**: 
  - Create/update/delete expense reports
  - Status transitions (DRAFT → SUBMITTED → APPROVED/REJECTED)
  - Calculate total amounts
  - Report filtering and pagination

- **`expenses.service.ts`**: 
  - Expense CRUD operations
  - Link expenses to reports
  - Status management

- **`receipts.service.ts`**: 
  - Generate presigned S3 upload URLs
  - Confirm receipt uploads
  - Link receipts to expenses

- **`ocr.service.ts`**: 
  - Trigger OCR processing
  - Process receipts with OpenAI Vision API
  - Extract expense data (amount, date, merchant, etc.)
  - Update expense records with OCR results

- **`export.service.ts`**: 
  - Generate PDF reports
  - Generate Excel (XLSX) files
  - Generate CSV files
  - Upload exports to S3

- **`notification.service.ts`**: 
  - Send push notifications via FCM
  - Manage device tokens
  - Notification scheduling

- **`audit.service.ts`**: 
  - Log important actions
  - Track changes to reports/expenses
  - Maintain audit trail

### 6. Middleware (`src/middleware/`)

Express middleware for cross-cutting concerns.

**Middleware Stack:**

1. **`auth.middleware.ts`**:
   - Validates JWT access tokens
   - Extracts user information from token
   - Attaches user to request object
   - Returns 401 if token is invalid/expired

2. **`role.middleware.ts`**:
   - Checks user role against required roles
   - Used for admin-only endpoints
   - Returns 403 if role insufficient

3. **`validate.middleware.ts`**:
   - Validates request body/query/params using Zod schemas
   - Returns 400 with validation errors if invalid

4. **`error.middleware.ts`**:
   - Global error handler (must be last)
   - Catches all errors
   - Formats error responses consistently
   - Logs errors

5. **`rateLimit.middleware.ts`**:
   - Prevents abuse with rate limiting
   - Different limits for different endpoints
   - Stricter limits for login/signup

### 7. Utils (`src/utils/`)

Reusable utility functions.

- **`logger.ts`**: Structured logging with different log levels
- **`pagination.ts`**: Pagination helpers for list endpoints
- **`s3.ts`**: S3 upload/download helper functions
- **`enums.ts`**: TypeScript enums for statuses, roles, etc.
- **`dtoTypes.ts`**: Zod schemas for request/response validation

---

## Data Flow

### Example: Creating an Expense Report

```
1. Client sends POST /api/v1/reports
   ↓
2. Rate Limiter checks request frequency
   ↓
3. CORS middleware validates origin
   ↓
4. Body parser extracts JSON
   ↓
5. Validation middleware checks request body
   ↓
6. Auth middleware validates JWT token
   ↓
7. Reports Controller receives request
   ↓
8. Reports Service creates report in database
   ↓
9. Service updates user's report count
   ↓
10. Audit Service logs the action
    ↓
11. Controller formats response
    ↓
12. Response sent to client
```

### Example: OCR Processing Flow

```
1. Client uploads receipt to S3 (using presigned URL)
   ↓
2. Client calls POST /api/v1/receipts/:id/confirm
   ↓
3. Receipts Controller confirms upload
   ↓
4. OCR Service creates OcrJob (status: QUEUED)
   ↓
5. OCR Service downloads image from S3
   ↓
6. OCR Service calls OpenAI Vision API
   ↓
7. OpenAI returns extracted data
   ↓
8. OCR Service updates OcrJob (status: COMPLETED)
   ↓
9. OCR Service updates Expense with extracted data
   ↓
10. Notification Service sends push notification
    ↓
11. Client polls GET /api/v1/ocr/jobs/:id for status
```

---

## Authentication & Authorization

### Authentication Flow

1. **Signup/Login**: User provides email and password
2. **Password Verification**: Bcrypt compares password with hash
3. **Token Generation**: JWT tokens generated (access + refresh)
4. **Token Storage**: Client stores tokens (access in memory, refresh in secure storage)
5. **Request Authentication**: Access token sent in `Authorization: Bearer <token>` header
6. **Token Refresh**: When access token expires, client uses refresh token to get new access token

### Token Structure

**Access Token:**
- Expires in: 15 minutes
- Contains: `{ id, email, role }`
- Used for: API requests

**Refresh Token:**
- Expires in: 30 days
- Used for: Getting new access tokens

### User Roles

- **EMPLOYEE**: 
  - Create and manage own expense reports
  - Submit reports for approval
  - View own expenses and receipts

- **ADMIN**: 
  - All employee permissions
  - Approve/reject expense reports
  - View all users' reports
  - Manage projects and categories
  - Export reports
  - View dashboard analytics

- **BUSINESS_HEAD**: 
  - Similar to ADMIN
  - Additional analytics access
  - Business-level insights

### Authorization Middleware

Routes can be protected with:
- `authMiddleware`: Requires valid JWT token
- `roleMiddleware(['ADMIN'])`: Requires specific role(s)

---

## API Endpoints

### Authentication
- `POST /api/v1/auth/signup` - Create new user account
- `POST /api/v1/auth/login` - Login and get tokens
- `POST /api/v1/auth/refresh` - Refresh access token
- `POST /api/v1/auth/logout` - Logout (invalidate refresh token)

### Expense Reports
- `POST /api/v1/reports` - Create new report (EMPLOYEE)
- `GET /api/v1/reports` - List user's reports (with filters)
- `GET /api/v1/reports/:id` - Get report details
- `PATCH /api/v1/reports/:id` - Update report (DRAFT only)
- `DELETE /api/v1/reports/:id` - Delete report (DRAFT only)
- `POST /api/v1/reports/:id/submit` - Submit report for approval

### Expenses
- `POST /api/v1/reports/:reportId/expenses` - Add expense to report
- `GET /api/v1/expenses` - List expenses (with filters)
- `GET /api/v1/expenses/:id` - Get expense details
- `PATCH /api/v1/expenses/:id` - Update expense
- `DELETE /api/v1/expenses/:id` - Delete expense

### Receipts & OCR
- `POST /api/v1/expenses/:expenseId/receipts/upload-intent` - Get presigned S3 URL
- `POST /api/v1/receipts/:receiptId/confirm` - Confirm upload and trigger OCR
- `GET /api/v1/receipts/:id` - Get receipt details
- `GET /api/v1/ocr/jobs/:id` - Get OCR job status

### Projects & Categories
- `GET /api/v1/projects` - List projects
- `POST /api/v1/projects` - Create project (ADMIN)
- `GET /api/v1/categories` - List categories
- `POST /api/v1/categories` - Create category (ADMIN)

### Admin Endpoints
- `GET /api/v1/admin/reports` - List all reports (ADMIN)
- `POST /api/v1/admin/reports/:id/approve` - Approve report
- `POST /api/v1/admin/reports/:id/reject` - Reject report
- `GET /api/v1/admin/reports/:id/export` - Export report (PDF/Excel/CSV)
- `GET /api/v1/admin/expenses` - List all expenses
- `POST /api/v1/admin/expenses/:id/approve` - Approve expense
- `POST /api/v1/admin/expenses/:id/reject` - Reject expense
- `GET /api/v1/admin/summary/dashboard` - Dashboard metrics

### Notifications
- `POST /api/v1/notifications/tokens` - Register device token
- `DELETE /api/v1/notifications/tokens/:token` - Unregister device token

---

## External Integrations

### 1. MongoDB Atlas
- **Purpose**: Primary database
- **Connection**: Managed via Mongoose
- **Features**: 
  - Automatic connection pooling
  - Index optimization
  - Schema validation

### 2. AWS S3
- **Purpose**: File storage for receipts and exports
- **Buckets**:
  - `expense-receipts-bucket`: Receipt images
  - `expense-exports-bucket`: Generated PDF/Excel/CSV files
- **Features**:
  - Presigned URLs for direct client uploads
  - Secure file access
  - Automatic cleanup of old files

### 3. OpenAI API
- **Purpose**: OCR and data extraction from receipts
- **Model**: GPT-4o Vision
- **Process**:
  1. Receipt image sent to OpenAI
  2. GPT-4o analyzes image
  3. Extracts: amount, date, merchant, category, etc.
  4. Returns structured JSON data
  5. Data used to populate expense fields

### 4. Firebase Cloud Messaging (FCM)
- **Purpose**: Push notifications to mobile/web clients
- **Features**:
  - Device token management
  - Notification delivery
  - Status updates (OCR complete, report approved, etc.)

### 5. Resend
- **Purpose**: Transactional emails
- **Use Cases**:
  - Report approval/rejection notifications
  - Password reset (if implemented)
  - Welcome emails

---

## Database Models

### User Model
```typescript
{
  email: string (unique, lowercase)
  passwordHash: string (bcrypt)
  name?: string
  role: 'EMPLOYEE' | 'ADMIN' | 'BUSINESS_HEAD'
  status: 'ACTIVE' | 'INACTIVE'
  lastLoginAt?: Date
  createdAt: Date
  updatedAt: Date
}
```

### ExpenseReport Model
```typescript
{
  userId: ObjectId (ref: User)
  projectId?: ObjectId (ref: Project)
  name: string
  notes?: string
  fromDate: Date
  toDate: Date
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'
  totalAmount: number
  currency: string (default: 'INR')
  submittedAt?: Date
  approvedAt?: Date
  rejectedAt?: Date
  updatedBy?: ObjectId (ref: User)
  createdAt: Date
  updatedAt: Date
}
```

### Expense Model
```typescript
{
  reportId: ObjectId (ref: ExpenseReport)
  categoryId?: ObjectId (ref: Category)
  amount: number
  currency: string
  date: Date
  description: string
  merchant?: string
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED'
  source: 'SCANNED' | 'MANUAL'
  receiptId?: ObjectId (ref: Receipt)
  createdAt: Date
  updatedAt: Date
}
```

### Receipt Model
```typescript
{
  expenseId: ObjectId (ref: Expense)
  s3Key: string (S3 object key)
  s3Url: string (S3 URL)
  mimeType: string
  size: number (bytes)
  ocrJobId?: ObjectId (ref: OcrJob)
  createdAt: Date
  updatedAt: Date
}
```

### OcrJob Model
```typescript
{
  receiptId: ObjectId (ref: Receipt)
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
  result?: {
    amount?: number
    date?: Date
    merchant?: string
    category?: string
    // ... other extracted fields
  }
  error?: string
  startedAt?: Date
  completedAt?: Date
  createdAt: Date
  updatedAt: Date
}
```

---

## Development Workflow

### Local Development

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Setup Environment**:
   ```bash
   cp env.example .env
   # Edit .env with your credentials
   ```

3. **Run in Development Mode**:
   ```bash
   npm run dev
   ```
   - Uses `tsx watch` for hot reloading
   - Server runs on port 4000 (or configured port)
   - Automatically restarts on file changes

4. **Build for Production**:
   ```bash
   npm run build
   ```
   - Compiles TypeScript to JavaScript in `dist/` folder

5. **Run Production Build**:
   ```bash
   npm start
   ```
   - Runs compiled JavaScript from `dist/`

### Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

### Linting

```bash
npm run lint
```

### Port Configuration

- Default port: `4000`
- Configurable via `APP_PORT` environment variable
- Server automatically finds available port if default is occupied
- For Android emulator: Use `http://10.0.2.2:4000`

---

## Deployment

### Docker Deployment

**Build Image**:
```bash
docker build -t expense-tracker-backend .
```

**Run Container**:
```bash
docker run -p 4000:4000 --env-file .env expense-tracker-backend
```

### Docker Compose

**Development Setup**:
```bash
docker-compose up
```

Includes:
- Backend application container
- MongoDB container
- Automatic volume mounting for development
- Network configuration

### Production Considerations

1. **Environment Variables**: All secrets in `.env` file
2. **Database**: Use MongoDB Atlas (cloud) or managed MongoDB
3. **File Storage**: AWS S3 buckets configured
4. **Security**: 
   - Helmet for security headers
   - CORS configured for specific origins
   - Rate limiting enabled
5. **Logging**: Structured logging for monitoring
6. **Error Handling**: Global error middleware catches all errors
7. **Graceful Shutdown**: Handles SIGTERM/SIGINT signals

### Health Check

Endpoint: `GET /health`

Returns:
```json
{
  "success": true,
  "message": "Server is healthy",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

## Key Features

### 1. State Machine for Reports
- **DRAFT**: Editable, can add/remove expenses
- **SUBMITTED**: Locked, awaiting approval
- **APPROVED**: Final state, cannot be modified
- **REJECTED**: Can be edited and resubmitted

### 2. OCR Processing
- Asynchronous processing
- Status tracking via OcrJob model
- Automatic expense data population
- Error handling and retry logic

### 3. File Upload Flow
- Presigned S3 URLs for direct client uploads
- No file passes through backend server
- Secure, scalable file storage

### 4. Export Functionality
- Multiple formats: PDF, Excel (XLSX), CSV
- Includes all report details and expenses
- Uploaded to S3 for download

### 5. Audit Trail
- All important actions logged
- Tracks who did what and when
- Immutable audit log

### 6. Pagination
- All list endpoints support pagination
- Query parameters: `page`, `limit`
- Returns metadata: total count, page info

---

## Security Features

1. **Password Hashing**: Bcrypt with salt rounds
2. **JWT Tokens**: Secure token-based authentication
3. **Rate Limiting**: Prevents brute force attacks
4. **CORS**: Restricts cross-origin requests
5. **Helmet**: Security headers (XSS protection, etc.)
6. **Input Validation**: Zod schemas validate all inputs
7. **Role-Based Access**: Middleware enforces permissions
8. **Secure File Storage**: S3 with presigned URLs

---

## Error Handling

### Error Response Format
```json
{
  "success": false,
  "message": "Error message",
  "code": "ERROR_CODE",
  "errors": [] // Optional validation errors
}
```

### Error Middleware
- Catches all unhandled errors
- Logs errors for debugging
- Returns appropriate HTTP status codes
- Formats error responses consistently

---

## Summary

The BACKEND folder is a **production-ready, scalable Node.js API** built with TypeScript and Express. It provides:

- ✅ Complete expense management system
- ✅ AI-powered receipt OCR
- ✅ Role-based access control
- ✅ Secure file storage
- ✅ Push notifications
- ✅ Export functionality
- ✅ Comprehensive audit trail
- ✅ Docker support
- ✅ Well-structured, maintainable codebase

The architecture follows best practices with clear separation of concerns, making it easy to maintain, test, and extend.


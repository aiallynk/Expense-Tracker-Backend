# Backend API & Authentication Architecture Documentation
## Microsoft Fabric / Power BI Integration Analysis

**Generated:** December 2024  
**Purpose:** Read-only analytics integration for external dashboards  
**Status:** Analysis Only - No Code Changes

---

## SECTION 1: API INVENTORY

### AUTHENTICATION MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| POST | `/api/v1/auth/signup` | User registration | `{email, password, name, role?}` | `{success, user: {id, email, name, role}, tokens: {accessToken, refreshToken}}` | Public | NO |
| POST | `/api/v1/auth/login` | User login | `{email, password}` | `{success, user: {id, email, name, role, companyId?}, tokens: {accessToken, refreshToken}}` | Public | NO |
| POST | `/api/v1/auth/refresh` | Refresh access token | `{refreshToken}` | `{success, accessToken}` | Public | NO |
| POST | `/api/v1/auth/logout` | Logout (client-side) | None | `{success, message}` | Any | NO |

### USERS MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/users/me` | Get current user profile | None | `{success, data: {id, email, name, role, companyId, ...}}` | Any | YES |
| PATCH | `/api/v1/users/me` | Update own profile | `{name?, phone?}` | `{success, data: User}` | Any | YES |
| GET | `/api/v1/users/companies` | List available companies | None | `{success, data: Company[]}` | Any | YES |
| GET | `/api/v1/users/logo` | Get company logo | None | `{success, data: {logoUrl}}` | Any | YES |
| GET | `/api/v1/users` | List all users | Query: `page, pageSize, role?, status?, search?` | `{success, data: User[], pagination}` | ADMIN+ | YES |
| POST | `/api/v1/users` | Create user | `{email, password, name, role, companyId?, departmentId?, managerId?}` | `{success, data: User}` | ADMIN+ | YES |
| GET | `/api/v1/users/:id` | Get user by ID | Path: `id` | `{success, data: User}` | ADMIN+ | YES |
| PATCH | `/api/v1/users/:id` | Update user | Path: `id`, Body: `{name?, role?, status?, ...}` | `{success, data: User}` | ADMIN+ | YES |

### EXPENSE REPORTS MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| POST | `/api/v1/reports` | Create expense report | `{name, description?, projectId?, costCentreId?}` | `{success, data: ExpenseReport}` | Any | YES |
| GET | `/api/v1/reports` | List reports | Query: `page, pageSize, status?, fromDate?, toDate?` | `{success, data: ExpenseReport[], pagination}` | Any | YES |
| GET | `/api/v1/reports/:id` | Get report details | Path: `id` | `{success, data: ExpenseReport with expenses}` | Any | YES |
| PATCH | `/api/v1/reports/:id` | Update report | Path: `id`, Body: `{name?, description?}` | `{success, data: ExpenseReport}` | Owner | YES |
| DELETE | `/api/v1/reports/:id` | Delete report | Path: `id` | `{success, message}` | Owner | YES |
| POST | `/api/v1/reports/:id/submit` | Submit for approval | Path: `id` | `{success, data: ExpenseReport}` | Owner | YES |
| POST | `/api/v1/reports/:id/action` | Approve/reject/request changes | Path: `id`, Body: `{action: 'approve'\|'reject'\|'request_changes', comment?}` | `{success, data: ExpenseReport}` | Approver | YES |
| POST | `/api/v1/reports/:reportId/expenses` | Add expense to report | Path: `reportId`, Body: `{amount, categoryId, merchant, expenseDate, currency?, receiptId?}` | `{success, data: Expense}` | Owner | YES |

### EXPENSES MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/expenses` | List expenses | Query: `page, pageSize, reportId?, status?, fromDate?, toDate?` | `{success, data: Expense[], pagination}` | Any | YES |
| GET | `/api/v1/expenses/:id` | Get expense details | Path: `id` | `{success, data: Expense}` | Any | YES |
| PATCH | `/api/v1/expenses/:id` | Update expense | Path: `id`, Body: `{amount?, categoryId?, merchant?, expenseDate?}` | `{success, data: Expense}` | Owner | YES |
| DELETE | `/api/v1/expenses/:id` | Delete expense | Path: `id` | `{success, message}` | Owner | YES |

### ADMIN MODULE (Analytics-Ready)

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/admin/summary/dashboard` | **Dashboard statistics** | Query: None | `{success, data: {totalReports, totalExpenses, pendingReports, approvedReports, totalAmount, totalAmountThisMonth, totalUsers, employees, managers, businessHeads}}` | ADMIN+ | YES |
| GET | `/api/v1/admin/summary/storage-growth` | **Storage growth analytics** | Query: `year?` | `{success, data: {monthlyData: [{month, storageGB, receiptsCount}]}}` | ADMIN+ | YES |
| GET | `/api/v1/admin/reports` | List all reports (filtered) | Query: `page, pageSize, status?, fromDate?, toDate?, userId?, companyId?` | `{success, data: ExpenseReport[], pagination}` | ADMIN+ | YES |
| GET | `/api/v1/admin/expenses` | List all expenses (filtered) | Query: `page, pageSize, status?, fromDate?, toDate?, userId?` | `{success, data: Expense[], pagination}` | ADMIN+ | YES |
| GET | `/api/v1/admin/export/csv` | **Bulk CSV export** | Query: `fromDate?, toDate?, status?, companyId?` | CSV file download | ADMIN/ACCOUNTANT | YES |
| GET | `/api/v1/admin/activity` | Activity logs | Query: `page, pageSize, actionType?, entityType?, userId?, fromDate?, toDate?` | `{success, data: AuditLog[], pagination}` | ADMIN+ | YES |
| GET | `/api/v1/admin/activity/recent` | Recent activity | Query: `limit?` | `{success, data: AuditLog[]}` | ADMIN+ | YES |
| POST | `/api/v1/admin/reports/:id/approve` | Approve report | Path: `id` | `{success, data: ExpenseReport}` | ADMIN+ | YES |
| POST | `/api/v1/admin/reports/:id/reject` | Reject report | Path: `id` | `{success, data: ExpenseReport}` | ADMIN+ | YES |
| GET | `/api/v1/admin/reports/:id/export` | Export single report | Path: `id`, Query: `format?` (XLSX/PDF) | `{success, data: {downloadUrl}}` | ADMIN+ | YES |

### COMPANY ADMIN MODULE (Analytics-Ready)

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/company-admin/settings` | Get company settings | None | `{success, data: CompanySettings}` | COMPANY_ADMIN | YES |
| PUT | `/api/v1/company-admin/settings` | Update settings | Body: `{approvalFlow, expense, general, notifications}` | `{success, data: CompanySettings}` | COMPANY_ADMIN | YES |
| GET | `/api/v1/company-admin/approval-rules` | List approval rules | None | `{success, data: ApprovalRule[]}` | COMPANY_ADMIN | YES |
| POST | `/api/v1/company-admin/approval-rules` | Create approval rule | Body: `{triggerType, thresholdValue, approverRole, description?}` | `{success, data: ApprovalRule}` | COMPANY_ADMIN | YES |
| PUT | `/api/v1/company-admin/approval-rules/:id` | Update rule | Path: `id`, Body: `{...}` | `{success, data: ApprovalRule}` | COMPANY_ADMIN | YES |
| DELETE | `/api/v1/company-admin/approval-rules/:id` | Delete rule | Path: `id` | `{success, message}` | COMPANY_ADMIN | YES |
| GET | `/api/v1/company-admin/approver-mappings` | List approver mappings | None | `{success, data: ApproverMapping[]}` | COMPANY_ADMIN | YES |
| GET | `/api/v1/company-admin/approver-mappings/:userId` | Get user mapping | Path: `userId` | `{success, data: ApproverMapping}` | COMPANY_ADMIN | YES |
| POST | `/api/v1/company-admin/approver-mappings` | Create/update mapping | Body: `{userId, level1ApproverId?, ...level5ApproverId?}` | `{success, data: ApproverMapping}` | COMPANY_ADMIN | YES |
| DELETE | `/api/v1/company-admin/approver-mappings/:userId` | Delete mapping | Path: `userId` | `{success, message}` | COMPANY_ADMIN | YES |

### MANAGER MODULE (Analytics-Ready)

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/manager/dashboard` | **Manager dashboard stats** | None | `{success, data: {pendingApprovals, teamReports, teamExpenses, totalSpend, ...}}` | MANAGER | YES |
| GET | `/api/v1/manager/team/members` | List team members | None | `{success, data: User[]}` | MANAGER | YES |
| GET | `/api/v1/manager/team/reports` | List team reports | Query: `page, pageSize, status?` | `{success, data: ExpenseReport[], pagination}` | MANAGER | YES |
| GET | `/api/v1/manager/team/reports/:id` | Get report for review | Path: `id` | `{success, data: ExpenseReport}` | MANAGER | YES |
| POST | `/api/v1/manager/team/reports/:id/approve` | Approve report | Path: `id`, Body: `{comment?}` | `{success, data: ExpenseReport}` | MANAGER | YES |
| POST | `/api/v1/manager/team/reports/:id/reject` | Reject report | Path: `id`, Body: `{comment?}` | `{success, data: ExpenseReport}` | MANAGER | YES |
| GET | `/api/v1/manager/team/expenses` | List team expenses | Query: `page, pageSize, status?` | `{success, data: Expense[], pagination}` | MANAGER | YES |
| POST | `/api/v1/manager/team/expenses/:id/approve` | Approve expense | Path: `id` | `{success, data: Expense}` | MANAGER | YES |
| POST | `/api/v1/manager/team/expenses/:id/reject` | Reject expense | Path: `id`, Body: `{comment?}` | `{success, data: Expense}` | MANAGER | YES |
| POST | `/api/v1/manager/team/expenses/:id/request-changes` | Request expense changes | Path: `id`, Body: `{comment}` | `{success, data: Expense}` | MANAGER | YES |
| GET | `/api/v1/manager/teams` | List teams | None | `{success, data: Team[]}` | MANAGER | YES |
| GET | `/api/v1/manager/teams/:teamId/spending` | **Team spending details** | Path: `teamId` | `{success, data: {totalSpend, expensesByCategory, ...}}` | MANAGER | YES |

### BUSINESS HEAD MODULE (Analytics-Ready)

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/business-head/dashboard` | **Business Head dashboard** | None | `{success, data: {pendingReports, totalReports, totalSpend, ...}}` | BUSINESS_HEAD | YES |
| GET | `/api/v1/business-head/reports` | List company reports | Query: `page, pageSize, status?` | `{success, data: ExpenseReport[], pagination}` | BUSINESS_HEAD | YES |
| GET | `/api/v1/business-head/reports/pending` | List pending reports | Query: `page, pageSize` | `{success, data: ExpenseReport[], pagination}` | BUSINESS_HEAD | YES |
| GET | `/api/v1/business-head/reports/:id` | Get report details | Path: `id` | `{success, data: ExpenseReport}` | BUSINESS_HEAD | YES |
| POST | `/api/v1/business-head/reports/:id/approve` | Approve report | Path: `id`, Body: `{comment?}` | `{success, data: ExpenseReport}` | BUSINESS_HEAD | YES |
| POST | `/api/v1/business-head/reports/:id/reject` | Reject report | Path: `id`, Body: `{comment?}` | `{success, data: ExpenseReport}` | BUSINESS_HEAD | YES |
| POST | `/api/v1/business-head/reports/:id/request-changes` | Request changes | Path: `id`, Body: `{comment}` | `{success, data: ExpenseReport}` | BUSINESS_HEAD | YES |
| GET | `/api/v1/business-head/managers` | List managers | None | `{success, data: User[]}` | BUSINESS_HEAD | YES |
| GET | `/api/v1/business-head/managers/:id` | Get manager details | Path: `id` | `{success, data: User with stats}` | BUSINESS_HEAD | YES |

### ACCOUNTANT MODULE (Analytics-Ready)

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/accountant/dashboard` | **Accountant dashboard** | None | `{success, data: {totalSpend, totalReports, pendingApprovals, departmentWiseSpend, projectWiseSpend, costCentreWiseSpend, monthlyTrends}}` | ACCOUNTANT | YES |
| GET | `/api/v1/accountant/reports` | List reports (read-only) | Query: `page, pageSize, status?, departmentId?, projectId?, costCentreId?` | `{success, data: ExpenseReport[], pagination}` | ACCOUNTANT | YES |
| GET | `/api/v1/accountant/reports/:id` | Get report details | Path: `id` | `{success, data: ExpenseReport}` | ACCOUNTANT | YES |
| GET | `/api/v1/accountant/expenses/department-wise` | **Department-wise expenses** | Query: `fromDate?, toDate?` | `{success, data: [{department, totalSpend, expenseCount}]}` | ACCOUNTANT | YES |
| GET | `/api/v1/accountant/expenses/project-wise` | **Project-wise expenses** | Query: `fromDate?, toDate?` | `{success, data: [{project, totalSpend, expenseCount}]}` | ACCOUNTANT | YES |
| GET | `/api/v1/accountant/expenses/cost-centre-wise` | **Cost centre-wise expenses** | Query: `fromDate?, toDate?` | `{success, data: [{costCentre, totalSpend, expenseCount}]}` | ACCOUNTANT | YES |
| GET | `/api/v1/accountant/export/csv` | **Bulk CSV export** | Query: `fromDate?, toDate?, status?` | CSV file download | ACCOUNTANT | YES |

### SUPER ADMIN MODULE (Analytics-Ready)

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/super-admin/dashboard/stats` | **Platform-wide stats** | None | `{success, data: {totalCompanies, activeCompanies, totalUsers, activeUsers, storageUsed, ocrUsage, reportsCreated, expensesCreated, receiptsUploaded, totalAmountApproved, ...}}` | SUPER_ADMIN | YES |
| GET | `/api/v1/super-admin/system-analytics` | **System analytics** | Query: `period?` (7d/30d/90d/1y) | `{success, data: {revenueTrend, platformUsage, userGrowth, companySignups}}` | SUPER_ADMIN | YES |
| GET | `/api/v1/super-admin/system-analytics/detailed` | **Detailed analytics** | Query: `period?` | `{success, data: {...detailed metrics}}` | SUPER_ADMIN | YES |
| GET | `/api/v1/super-admin/platform/stats` | **Platform statistics** | None | `{success, data: {...platform metrics}}` | SUPER_ADMIN | YES |
| GET | `/api/v1/super-admin/companies` | List companies | Query: `page, pageSize, status?, sortBy?` | `{success, data: Company[], pagination}` | SUPER_ADMIN | YES |
| GET | `/api/v1/super-admin/logs` | System logs | Query: `page, pageSize, level?` | `{success, data: Log[], pagination}` | SUPER_ADMIN | YES |

### PROJECTS MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/projects` | List projects | Query: `page, pageSize` | `{success, data: Project[], pagination}` | Any | YES |
| GET | `/api/v1/projects/:id` | Get project details | Path: `id` | `{success, data: Project}` | Any | YES |
| GET | `/api/v1/projects/admin/list` | List all projects (admin) | Query: `page, pageSize, companyId?` | `{success, data: Project[], pagination}` | COMPANY_ADMIN | YES |
| POST | `/api/v1/projects` | Create project | Body: `{name, code, description?, managerId?, startDate?, endDate?, budget?, status?}` | `{success, data: Project}` | COMPANY_ADMIN | YES |
| PATCH | `/api/v1/projects/:id` | Update project | Path: `id`, Body: `{...}` | `{success, data: Project}` | COMPANY_ADMIN | YES |
| DELETE | `/api/v1/projects/:id` | Delete project | Path: `id` | `{success, message}` | COMPANY_ADMIN | YES |

### CATEGORIES MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/categories` | List categories | Query: `page, pageSize` | `{success, data: Category[], pagination}` | Any | YES |
| GET | `/api/v1/categories/:id` | Get category | Path: `id` | `{success, data: Category}` | Any | YES |
| GET | `/api/v1/categories/name/:name` | Get or create by name | Path: `name` | `{success, data: Category}` | Any | YES |
| GET | `/api/v1/categories/admin/list` | List all (admin) | Query: `page, pageSize, companyId?` | `{success, data: Category[], pagination}` | COMPANY_ADMIN | YES |
| POST | `/api/v1/categories/admin/initialize` | Initialize defaults | None | `{success, message}` | COMPANY_ADMIN | YES |
| POST | `/api/v1/categories` | Create category | Body: `{name, code, description?}` | `{success, data: Category}` | COMPANY_ADMIN | YES |
| PATCH | `/api/v1/categories/:id` | Update category | Path: `id`, Body: `{...}` | `{success, data: Category}` | COMPANY_ADMIN | YES |
| DELETE | `/api/v1/categories/:id` | Delete category | Path: `id` | `{success, message}` | COMPANY_ADMIN | YES |

### DEPARTMENTS MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/departments` | List departments | Query: `page, pageSize` | `{success, data: Department[], pagination}` | Any | YES |
| GET | `/api/v1/departments/:id` | Get department | Path: `id` | `{success, data: Department}` | Any | YES |
| POST | `/api/v1/departments/initialize-defaults` | Initialize defaults | None | `{success, message}` | COMPANY_ADMIN | YES |
| POST | `/api/v1/departments` | Create department | Body: `{name, code, description?, headId?}` | `{success, data: Department}` | COMPANY_ADMIN | YES |
| PATCH | `/api/v1/departments/:id` | Update department | Path: `id`, Body: `{...}` | `{success, data: Department}` | COMPANY_ADMIN | YES |
| DELETE | `/api/v1/departments/:id` | Delete department | Path: `id` | `{success, message}` | COMPANY_ADMIN | YES |

### COST CENTRES MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/cost-centres` | List cost centres | Query: `page, pageSize` | `{success, data: CostCentre[], pagination}` | Any | YES |
| GET | `/api/v1/cost-centres/:id` | Get cost centre | Path: `id` | `{success, data: CostCentre}` | Any | YES |
| GET | `/api/v1/cost-centres/name/:name` | Get or create by name | Path: `name` | `{success, data: CostCentre}` | Any | YES |
| GET | `/api/v1/cost-centres/admin/list` | List all (admin) | Query: `page, pageSize, companyId?` | `{success, data: CostCentre[], pagination}` | COMPANY_ADMIN | YES |
| POST | `/api/v1/cost-centres` | Create cost centre | Body: `{name, code, description?}` | `{success, data: CostCentre}` | COMPANY_ADMIN | YES |
| PATCH | `/api/v1/cost-centres/:id` | Update cost centre | Path: `id`, Body: `{...}` | `{success, data: CostCentre}` | COMPANY_ADMIN | YES |
| DELETE | `/api/v1/cost-centres/:id` | Delete cost centre | Path: `id` | `{success, message}` | COMPANY_ADMIN | YES |

### RECEIPTS MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| POST | `/api/v1/expenses/:expenseId/receipts/upload-intent` | Create upload intent | Path: `expenseId`, Body: `{fileName, fileSize, fileType}` | `{success, data: {uploadUrl, receiptId}}` | Any | YES |
| POST | `/api/v1/receipts/:receiptId/confirm` | Confirm upload | Path: `receiptId` | `{success, data: Receipt}` | Any | YES |
| GET | `/api/v1/receipts/:id` | Get receipt | Path: `id` | `{success, data: Receipt}` | Any | YES |
| POST | `/api/v1/receipts/:receiptId/upload` | Upload file (binary) | Path: `receiptId`, Body: Binary | `{success, data: Receipt}` | Any | YES |

### OCR MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/api/v1/ocr/jobs/:id` | Get OCR job status | Path: `id` | `{success, data: {status, result?}}` | Any | YES |

### NOTIFICATIONS MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| POST | `/api/v1/notifications/register-token` | Register FCM token | Body: `{token, platform}` | `{success, message}` | Any | YES |

### BULK UPLOAD MODULE

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| POST | `/api/v1/bulk-upload/intent` | Create bulk upload intent | Body: `{fileName, fileSize, fileType}` | `{success, data: {uploadUrl, jobId}}` | Any | YES |
| POST | `/api/v1/bulk-upload/confirm` | Confirm bulk upload | Body: `{jobId}` | `{success, data: {jobId, status}}` | Any | YES |
| GET | `/api/v1/bulk-upload/supported-types` | Get supported file types | None | `{success, data: {types: string[]}}` | Any | YES |

### HEALTH CHECK (Public)

| Method | Route | Purpose | Parameters | Response | Role | Auth |
|--------|-------|---------|------------|----------|------|------|
| GET | `/health` | Health check | None | `{success, message, timestamp, database: {connected, status}}` | Public | NO |
| GET | `/healthz` | Health check (with Redis) | None | `{success, message, timestamp, database: {connected, status}, redis: {connected, status}}` | Public | NO |

---

## SECTION 2: AUTHENTICATION FLOW ANALYSIS

### JWT Authentication Overview

**Middleware:** `BACKEND/src/middleware/auth.middleware.ts`  
**Validation:** All routes under `/api/v1/*` (except `/health` and `/healthz`)

### JWT Structure

**Access Token Payload:**
```json
{
  "id": "user_id_string",
  "email": "user@example.com",
  "role": "EMPLOYEE|MANAGER|BUSINESS_HEAD|ADMIN|COMPANY_ADMIN|ACCOUNTANT|SUPER_ADMIN",
  "companyId": "company_id_string"
}
```

**Refresh Token Payload:**
```json
{
  "id": "user_id_string",
  "email": "user@example.com",
  "role": "EMPLOYEE|...",
  "companyId": "company_id_string"
}
```

### Token Expiry Configuration

**Location:** `BACKEND/src/config/env.ts` and `BACKEND/src/config/index.ts`

- **Access Token:** `JWT_ACCESS_EXPIRES_IN` (default: `15m` in env, fallback: `100y`)
- **Refresh Token:** `JWT_REFRESH_EXPIRES_IN` (default: `30d` in env, fallback: `100y`)

**Current Implementation:**
- Access tokens are **short-lived** (15 minutes default)
- Refresh tokens are **long-lived** (30 days default)
- **Note:** Fallback values (`100y`) are likely for development only

### Authentication Flow

```
1. Client → POST /api/v1/auth/login
   Body: {email, password}
   
2. Server validates credentials
   - Checks User collection OR CompanyAdmin collection
   - Verifies password hash
   - Checks status === 'ACTIVE'
   
3. Server generates tokens
   - Access Token (15m expiry)
   - Refresh Token (30d expiry)
   
4. Server → Client
   Response: {
     success: true,
     user: {id, email, name, role, companyId?},
     tokens: {accessToken, refreshToken}
   }

5. Client stores tokens
   - Access token in memory/session
   - Refresh token in secure storage

6. Client makes API requests
   Header: Authorization: Bearer <accessToken>

7. Middleware validates
   - Extracts token from Authorization header
   - Verifies signature with JWT_ACCESS_SECRET
   - Checks expiry
   - Attaches user to req.user

8. Token refresh (when expired)
   Client → POST /api/v1/auth/refresh
   Body: {refreshToken}
   
   Server:
   - Validates refresh token with JWT_REFRESH_SECRET
   - Checks user still exists and is ACTIVE
   - Generates new access token
   - Returns: {success, accessToken}
```

### Role-Based Authorization

**Middleware:** `BACKEND/src/middleware/role.middleware.ts`

**Roles Hierarchy:**
1. `SUPER_ADMIN` - Platform owner
2. `COMPANY_ADMIN` - Company administrator
3. `ADMIN` - General admin
4. `BUSINESS_HEAD` - Business unit head
5. `MANAGER` - Team manager
6. `ACCOUNTANT` - Read-only financial analyst
7. `EMPLOYEE` - Regular user

**Authorization Checks:**
- `requireRole(...roles)` - Checks if `req.user.role` matches any allowed role
- `requireAdmin` - Allows: ADMIN, BUSINESS_HEAD, COMPANY_ADMIN, SUPER_ADMIN
- `requireCompanyAdmin` - Allows: COMPANY_ADMIN, SUPER_ADMIN

### Public vs Protected Endpoints

**Public Endpoints (No JWT Required):**
- `POST /api/v1/auth/signup`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /health`
- `GET /healthz`

**All Other Endpoints:** Require JWT in `Authorization: Bearer <token>` header

### Can JWT Be Bypassed for Analytics?

**Answer: NO** - Currently, all analytics endpoints require JWT authentication.

**Blockers:**
1. `authMiddleware` is applied to all `/api/v1/*` routes (except health checks)
2. No API key support exists
3. No service account mechanism
4. No public/semi-public analytics endpoints

---

## SECTION 3: DASHBOARD / ANALYTICS READINESS

### Analytics-Ready Endpoints

#### ✅ **Highly Suitable for Fabric/Power BI**

| Endpoint | Data Type | Aggregation | Date Filters | Status |
|----------|-----------|------------|--------------|--------|
| `GET /api/v1/admin/summary/dashboard` | Summary stats | ✅ Pre-aggregated | ❌ No (current month only) | Ready |
| `GET /api/v1/admin/summary/storage-growth` | Time series | ✅ Monthly aggregated | ✅ Yes (year param) | Ready |
| `GET /api/v1/accountant/dashboard` | Multi-dimensional | ✅ Pre-aggregated | ❌ No | Ready |
| `GET /api/v1/accountant/expenses/department-wise` | Dimension breakdown | ✅ Aggregated by dept | ✅ Yes (fromDate/toDate) | **Excellent** |
| `GET /api/v1/accountant/expenses/project-wise` | Dimension breakdown | ✅ Aggregated by project | ✅ Yes (fromDate/toDate) | **Excellent** |
| `GET /api/v1/accountant/expenses/cost-centre-wise` | Dimension breakdown | ✅ Aggregated by cost centre | ✅ Yes (fromDate/toDate) | **Excellent** |
| `GET /api/v1/admin/reports` | List data | ❌ Raw (needs aggregation) | ✅ Yes (fromDate/toDate) | Needs work |
| `GET /api/v1/admin/expenses` | List data | ❌ Raw (needs aggregation) | ✅ Yes (fromDate/toDate) | Needs work |
| `GET /api/v1/super-admin/system-analytics` | Time series | ✅ Pre-aggregated | ✅ Yes (period param) | **Excellent** |
| `GET /api/v1/super-admin/dashboard/stats` | Summary stats | ✅ Pre-aggregated | ❌ No | Ready |
| `GET /api/v1/manager/dashboard` | Summary stats | ✅ Pre-aggregated | ❌ No | Ready |
| `GET /api/v1/business-head/dashboard` | Summary stats | ✅ Pre-aggregated | ❌ No | Ready |

#### ⚠️ **Needs Optimization for Fabric**

| Endpoint | Issue | Recommendation |
|----------|-------|----------------|
| `GET /api/v1/admin/reports` | Returns raw list, not aggregated | Add aggregation query params: `groupBy=status\|user\|project`, `aggregate=count\|sum` |
| `GET /api/v1/admin/expenses` | Returns raw list, not aggregated | Add aggregation query params: `groupBy=category\|department\|project`, `aggregate=count\|sum` |
| `GET /api/v1/accountant/dashboard` | No date range filter | Add `fromDate`/`toDate` query params |
| `GET /api/v1/admin/summary/dashboard` | Hard-coded to current month | Add `month`/`year` query params |

### Missing Analytics Endpoints (Recommended)

1. **Monthly Expense Trends** - Time series by month
2. **Approval Status Breakdown** - Counts by status (PENDING_L1, PENDING_L2, APPROVED, REJECTED)
3. **Category-wise Spending** - Aggregated by expense category
4. **User-wise Spending** - Top spenders report
5. **Project Budget vs Actual** - Budget utilization
6. **Cost Centre Budget vs Actual** - Budget utilization
7. **Approval Matrix Analytics** - Approval level statistics

---

## SECTION 4: FABRIC / POWER BI COMPATIBILITY CHECK

### Why Fabric Cannot Connect Today

#### ❌ **BLOCKER 1: JWT-Only Access**
- **Issue:** All analytics endpoints require JWT Bearer token
- **Impact:** Fabric cannot authenticate without user credentials
- **Severity:** **CRITICAL**

#### ❌ **BLOCKER 2: Short-Lived Access Tokens**
- **Issue:** Access tokens expire in 15 minutes
- **Impact:** Fabric connections would break frequently
- **Severity:** **CRITICAL**

#### ❌ **BLOCKER 3: No Service Account Support**
- **Issue:** No dedicated service accounts for system integrations
- **Impact:** Must use real user credentials (security risk)
- **Severity:** **HIGH**

#### ❌ **BLOCKER 4: No API Key Support**
- **Issue:** No API key authentication mechanism
- **Impact:** Cannot use simple key-based auth
- **Severity:** **HIGH**

#### ⚠️ **BLOCKER 5: Refresh Token Required**
- **Issue:** Need to implement refresh logic in Fabric
- **Impact:** Complex authentication flow
- **Severity:** **MEDIUM** (can be worked around)

#### ✅ **NOT BLOCKERS:**
- **CORS:** Configured, allows external origins (in dev) or specific origins (in prod)
- **HTTPS:** Can be configured on deployment
- **Response Format:** JSON responses are Fabric-compatible
- **Rate Limiting:** Present but reasonable for analytics use

### Current Authentication Flow for Fabric

```
Fabric → POST /api/v1/auth/login
        Body: {email: "analytics@company.com", password: "..."}
        
Fabric ← {accessToken: "eyJ...", refreshToken: "eyJ..."}

Fabric → GET /api/v1/admin/summary/dashboard
        Header: Authorization: Bearer <accessToken>
        
Fabric ← {success: true, data: {...}}

[After 15 minutes]
Fabric → GET /api/v1/admin/summary/dashboard
        Header: Authorization: Bearer <expired_token>
        
Fabric ← 401 {code: "TOKEN_EXPIRED"}

Fabric → POST /api/v1/auth/refresh
        Body: {refreshToken: "..."}
        
Fabric ← {accessToken: "new_token"}

Fabric → GET /api/v1/admin/summary/dashboard (retry)
        Header: Authorization: Bearer <new_accessToken>
```

**Problems:**
1. Requires storing user credentials in Fabric
2. Token refresh logic must be implemented
3. 15-minute expiry is too short for scheduled refreshes
4. No way to distinguish service account from regular user

---

## SECTION 5: FABRIC-SAFE ACCESS STRATEGY

### Recommended Solution: **Service Account with Long-Lived Token**

#### Approach Overview

Create a dedicated **Service Account** system with:
1. Special user type: `SERVICE_ACCOUNT` role
2. Long-lived access tokens (e.g., 1 year expiry)
3. Read-only permissions for analytics endpoints
4. API key as alternative (optional enhancement)

#### Implementation Plan

**Step 1: Create Service Account Model**
```typescript
// BACKEND/src/models/ServiceAccount.ts
interface IServiceAccount {
  name: string;
  apiKey: string; // Hashed
  companyId?: ObjectId;
  allowedEndpoints: string[]; // Whitelist
  expiresAt?: Date;
  isActive: boolean;
}
```

**Step 2: Extend Auth Middleware**
```typescript
// BACKEND/src/middleware/auth.middleware.ts
// Add API key validation:
if (req.headers['x-api-key']) {
  const serviceAccount = await ServiceAccount.findOne({
    apiKey: hashedKey,
    isActive: true
  });
  if (serviceAccount) {
    req.user = { id: serviceAccount.id, role: 'SERVICE_ACCOUNT', ... };
    return next();
  }
}
```

**Step 3: Create Service Account Endpoints**
```typescript
// POST /api/v1/service-accounts (COMPANY_ADMIN only)
// GET /api/v1/service-accounts/:id/api-key (regenerate)
// DELETE /api/v1/service-accounts/:id (revoke)
```

**Step 4: Long-Lived Token Generation**
```typescript
// For service accounts, generate tokens with 1 year expiry
const token = jwt.sign(payload, secret, { expiresIn: '365d' });
```

**Step 5: Read-Only Permission Check**
```typescript
// Middleware to restrict service accounts to GET only
const requireServiceAccountReadOnly = (req, res, next) => {
  if (req.user.role === 'SERVICE_ACCOUNT' && req.method !== 'GET') {
    return res.status(403).json({ error: 'Service accounts are read-only' });
  }
  next();
};
```

#### Pros & Cons

**Pros:**
- ✅ No user credentials needed in Fabric
- ✅ Long-lived tokens (1 year) reduce refresh complexity
- ✅ Read-only by design (security)
- ✅ Can be revoked independently
- ✅ Company-scoped (service account tied to company)
- ✅ Minimal code changes (extend existing auth)

**Cons:**
- ⚠️ Requires new model and endpoints
- ⚠️ Token still expires (but 1 year is manageable)
- ⚠️ Need to manage service account lifecycle

#### Alternative: API Key Only (Simpler)

**Approach:** Add API key header support without service accounts

**Implementation:**
1. Add `X-API-Key` header support to `authMiddleware`
2. Store API keys in `CompanySettings` or new `ApiKey` model
3. Validate key and attach company context
4. Generate long-lived JWT on first use, cache it

**Pros:**
- ✅ Simpler implementation
- ✅ No service account management UI needed
- ✅ Works immediately

**Cons:**
- ⚠️ Less granular control
- ⚠️ Key rotation requires settings update

#### Security Considerations

1. **API Key Storage:** Hash keys in database (like passwords)
2. **Rate Limiting:** Apply stricter limits for service accounts
3. **IP Whitelisting:** Optional - restrict to Fabric IPs
4. **Audit Logging:** Log all service account API calls
5. **Key Rotation:** Provide mechanism to regenerate keys
6. **Expiry:** Set expiration dates for service accounts

#### Minimal Code Changes Required

**Files to Modify:**
1. `BACKEND/src/models/ServiceAccount.ts` (new)
2. `BACKEND/src/middleware/auth.middleware.ts` (extend)
3. `BACKEND/src/services/auth.service.ts` (add service account login)
4. `BACKEND/src/routes/auth.routes.ts` (add service account endpoints)
5. `BACKEND/src/controllers/auth.controller.ts` (add handlers)

**Estimated Effort:** 2-3 days

---

## SECTION 6: OUTPUT SUMMARY

### 1. API Table Summary

**Total Endpoints:** ~80+  
**Public Endpoints:** 5 (auth + health)  
**Protected Endpoints:** ~75+  
**Analytics-Ready:** 15+ endpoints

**Key Analytics Endpoints:**
- ✅ `/api/v1/admin/summary/dashboard`
- ✅ `/api/v1/accountant/expenses/department-wise`
- ✅ `/api/v1/accountant/expenses/project-wise`
- ✅ `/api/v1/accountant/expenses/cost-centre-wise`
- ✅ `/api/v1/super-admin/system-analytics`
- ✅ `/api/v1/admin/summary/storage-growth`

### 2. Authentication Flow Diagram

```
┌─────────┐
│  Fabric │
└────┬────┘
     │
     │ 1. POST /auth/login
     │    {email, password}
     ▼
┌─────────────────┐
│   Auth Service  │
│  - Validate     │
│  - Generate JWT │
└────┬────────────┘
     │
     │ 2. {accessToken, refreshToken}
     ▼
┌─────────┐
│  Fabric │ (stores tokens)
└────┬────┘
     │
     │ 3. GET /admin/summary/dashboard
     │    Header: Authorization: Bearer <token>
     ▼
┌──────────────────┐
│ authMiddleware   │
│  - Extract token │
│  - Verify JWT    │
│  - Attach user   │
└────┬─────────────┘
     │
     │ 4. req.user = {id, role, companyId}
     ▼
┌──────────────────┐
│ roleMiddleware   │
│  - Check role    │
│  - Verify access │
└────┬─────────────┘
     │
     │ 5. Authorized
     ▼
┌──────────────────┐
│  Controller      │
│  - Fetch data    │
│  - Return JSON   │
└────┬─────────────┘
     │
     │ 6. {success: true, data: {...}}
     ▼
┌─────────┐
│  Fabric │
└─────────┘

[Token Expires After 15m]
     │
     │ 7. GET /admin/summary/dashboard
     │    (with expired token)
     ▼
┌──────────────────┐
│ authMiddleware   │
│  - Token expired │
└────┬─────────────┘
     │
     │ 8. 401 {code: "TOKEN_EXPIRED"}
     ▼
┌─────────┐
│  Fabric │ (detects 401)
└────┬────┘
     │
     │ 9. POST /auth/refresh
     │    {refreshToken}
     ▼
┌──────────────────┐
│   Auth Service   │
│  - Validate RT   │
│  - New accessToken│
└────┬─────────────┘
     │
     │ 10. {accessToken: "new_token"}
     ▼
┌─────────┐
│  Fabric │ (retries request)
└─────────┘
```

### 3. Fabric-Compatible APIs (After Service Account Implementation)

| Endpoint | Compatibility | Notes |
|----------|---------------|-------|
| `GET /api/v1/admin/summary/dashboard` | ✅ High | Pre-aggregated, needs date params |
| `GET /api/v1/admin/summary/storage-growth` | ✅ High | Time series, has date filter |
| `GET /api/v1/accountant/dashboard` | ✅ High | Multi-dimensional stats |
| `GET /api/v1/accountant/expenses/department-wise` | ✅ **Excellent** | Perfect for Fabric |
| `GET /api/v1/accountant/expenses/project-wise` | ✅ **Excellent** | Perfect for Fabric |
| `GET /api/v1/accountant/expenses/cost-centre-wise` | ✅ **Excellent** | Perfect for Fabric |
| `GET /api/v1/super-admin/system-analytics` | ✅ **Excellent** | Time series with period filter |
| `GET /api/v1/admin/reports` | ⚠️ Medium | Needs aggregation params |
| `GET /api/v1/admin/expenses` | ⚠️ Medium | Needs aggregation params |

### 4. Exact Reason Fabric Fails Today

**PRIMARY BLOCKER:** JWT authentication with short-lived tokens

**Details:**
1. All endpoints require `Authorization: Bearer <token>` header
2. Access tokens expire in **15 minutes**
3. No API key or service account mechanism exists
4. Must use real user credentials (security risk)
5. Token refresh logic must be implemented in Fabric

**Secondary Issues:**
- Some endpoints lack date range filters
- Some endpoints return raw data instead of aggregated
- No dedicated analytics endpoints optimized for BI tools

### 5. Recommended Next-Step Integration Plan

#### Phase 1: Service Account Implementation (Week 1)

1. **Create Service Account Model**
   - Fields: `name`, `apiKey` (hashed), `companyId`, `allowedEndpoints[]`, `expiresAt`, `isActive`
   - Index on `apiKey` for fast lookup

2. **Extend Authentication Middleware**
   - Add `X-API-Key` header support
   - Validate API key → generate long-lived JWT (1 year)
   - Attach service account context to `req.user`

3. **Create Service Account Management Endpoints**
   - `POST /api/v1/service-accounts` (create)
   - `GET /api/v1/service-accounts` (list)
   - `POST /api/v1/service-accounts/:id/regenerate-key` (rotate)
   - `DELETE /api/v1/service-accounts/:id` (revoke)

4. **Add Read-Only Restriction**
   - Service accounts can only use GET methods
   - Return 403 for POST/PUT/DELETE

#### Phase 2: Analytics Endpoint Optimization (Week 2)

1. **Add Date Range Filters**
   - Update `/admin/summary/dashboard` to accept `month`, `year`, `fromDate`, `toDate`
   - Update `/accountant/dashboard` to accept date range

2. **Add Aggregation Endpoints**
   - `GET /api/v1/analytics/expenses/by-category?fromDate&toDate`
   - `GET /api/v1/analytics/approvals/by-status?fromDate&toDate`
   - `GET /api/v1/analytics/expenses/monthly-trend?months=12`

3. **Optimize Response Format**
   - Ensure consistent JSON structure
   - Add metadata (total count, date range, etc.)

#### Phase 3: Fabric Integration (Week 3)

1. **Create Service Account in Backend**
   - Generate API key
   - Configure allowed endpoints
   - Set expiration (1 year)

2. **Configure Fabric Data Source**
   - Use API key for authentication
   - Set up refresh schedule (daily/hourly)
   - Map endpoints to Fabric datasets

3. **Test & Validate**
   - Verify data accuracy
   - Test token refresh (if needed)
   - Monitor rate limits

#### Phase 4: Monitoring & Maintenance

1. **Audit Logging**
   - Log all service account API calls
   - Track usage patterns
   - Monitor for anomalies

2. **Key Rotation Policy**
   - Rotate keys quarterly
   - Update Fabric configuration
   - Test before production cutover

3. **Performance Monitoring**
   - Track API response times
   - Monitor database query performance
   - Optimize slow endpoints

---

## APPENDIX: Sample API Responses

### Dashboard Response
```json
{
  "success": true,
  "data": {
    "totalReports": 150,
    "totalExpenses": 450,
    "pendingReports": 12,
    "approvedReports": 120,
    "totalAmount": 125000.50,
    "totalAmountThisMonth": 15000.25,
    "totalUsers": 45,
    "employees": 35,
    "managers": 8,
    "businessHeads": 2
  }
}
```

### Department-Wise Expenses Response
```json
{
  "success": true,
  "data": [
    {
      "department": {
        "id": "dept123",
        "name": "Engineering",
        "code": "ENG"
      },
      "totalSpend": 50000.00,
      "expenseCount": 120,
      "currency": "INR"
    },
    {
      "department": {
        "id": "dept456",
        "name": "Sales",
        "code": "SALES"
      },
      "totalSpend": 30000.00,
      "expenseCount": 80,
      "currency": "INR"
    }
  ]
}
```

### System Analytics Response
```json
{
  "success": true,
  "data": {
    "revenueTrend": [
      {"date": "2024-01", "amount": 10000},
      {"date": "2024-02", "amount": 12000},
      {"date": "2024-03", "amount": 15000}
    ],
    "platformUsage": {
      "totalUsers": 500,
      "activeUsers": 350,
      "totalReports": 2000
    },
    "userGrowth": [
      {"month": "2024-01", "newUsers": 50},
      {"month": "2024-02", "newUsers": 60}
    ]
  }
}
```

---

**Document Status:** Complete  
**Next Action:** Review and approve service account implementation plan


import { z } from 'zod';

import {
  // UserRole, // Unused
  // UserStatus, // Unused
  ExpenseReportStatus,
  ExpenseStatus,
  ExpenseSource,
  ExportFormat,
} from './enums';

// Auth DTOs
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.string().optional(), // Optional role selection for users with multiple roles
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

// User DTOs
export const bulkUserActionSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1, 'At least one user ID is required'),
  action: z.enum(['activate', 'deactivate', 'delete'], {
    errorMap: () => ({ message: 'Action must be activate, deactivate, or delete' })
  }),
});

export const uploadProfileImageSchema = z.object({
  // File validation will be done in controller using multer
});

export const updateProfileSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  profileImage: z.string().url().optional().nullable(),
  companyId: z.string().optional(),
  departmentId: z.string().optional(),
  notificationSettings: z.object({
    email: z.boolean().optional(),
    push: z.boolean().optional(),
    expenseUpdates: z.boolean().optional(),
    reportStatus: z.boolean().optional(),
    approvalAlerts: z.boolean().optional(),
  }).optional(),
});

// Helper to transform empty strings to undefined
const emptyStringToUndefined = z.preprocess((val) => {
  if (val === '' || val === null) return undefined;
  return val;
}, z.string().optional());

export const createUserSchema = z.object({
  email: z.preprocess(
    (val) => {
      if (val === '' || val === null || val === undefined) return undefined;
      const trimmed = String(val).trim().toLowerCase();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().email('Valid email format is required (if provided)').optional()
  ),
  name: z.preprocess(
    (val) => {
      if (val === '' || val === null || val === undefined) return undefined;
      return String(val).trim();
    },
    z.string().optional()
  ),
  password: z.preprocess(
    (val) => {
      if (val === '' || val === null || val === undefined) return undefined;
      return String(val);
    },
    z.string().min(6, 'Password must be at least 6 characters').optional()
  ),
  phone: z.preprocess(
    (val) => {
      if (val === '' || val === null || val === undefined) return undefined;
      return String(val).trim();
    },
    z.string()
      .regex(/^(\+91)?[6-9]\d{9}$/, 'Invalid Indian mobile number. Must be +91XXXXXXXXXX or 10 digits starting with 6-9')
      .optional()
  ),
  role: z.enum(['EMPLOYEE', 'MANAGER', 'BUSINESS_HEAD', 'ACCOUNTANT'], {
    errorMap: () => ({ message: 'Role must be EMPLOYEE, MANAGER, BUSINESS_HEAD, or ACCOUNTANT' })
  }).optional().default('EMPLOYEE'),
  roles: z.array(z.string()).optional(), // Additional roles array (ObjectIds)
  companyId: emptyStringToUndefined,
  managerId: emptyStringToUndefined,
  departmentId: emptyStringToUndefined,
  status: z.enum(['ACTIVE', 'INACTIVE']).optional().default('ACTIVE'),
  employeeId: z.preprocess(
    (val) => {
      if (val === '' || val === null || val === undefined) return undefined;
      return String(val).trim().toUpperCase();
    },
    z.string().optional()
  ),
}).refine((data) => {
  // At least email or name must be provided
  const hasEmail = data.email && data.email.trim() !== '';
  const hasName = data.name && data.name.trim() !== '';
  return hasEmail || hasName;
}, {
  message: 'Either email or name must be provided',
  path: ['email'],
});

export const updateUserSchema = z.object({
  name: z.string().min(1, 'Name is required').trim().optional(),
  email: z.string().email('Valid email is required').trim().toLowerCase().optional(),
  role: z.enum(['EMPLOYEE', 'MANAGER', 'BUSINESS_HEAD', 'ACCOUNTANT']).optional(),
  roles: z.array(z.string()).optional(), // Additional roles array (ObjectIds)
  managerId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  phone: z.string()
    .regex(/^(\+91)?[6-9]\d{9}$/, 'Invalid Indian mobile number. Must be +91XXXXXXXXXX or 10 digits starting with 6-9')
    .optional()
    .nullable(),
});

// Project DTOs
export const createProjectSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

// Category DTOs
export const createCategorySchema = z.object({
  name: z.string().min(1, 'Category name is required'),
  code: z
    .union([z.string(), z.null(), z.undefined()])
    .optional()
    .transform((v) => (v != null && String(v).trim() !== '' ? String(v).trim() : undefined)),
  description: z
    .union([z.string(), z.null(), z.undefined()])
    .optional()
    .transform((v) => (v != null && String(v).trim() !== '' ? String(v).trim() : undefined)),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().optional(),
  description: z.string().optional(),
});

// Cost Centre DTOs
export const createCostCentreSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  budget: z.number().min(0).optional(),
});

export const updateCostCentreSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().optional(),
  description: z.string().optional(),
  budget: z.number().min(0).optional(),
});

// Expense Report DTOs
export const createReportSchema = z.object({
  // Name is optional; server will auto-generate a default if missing/blank
  name: z.string().optional().or(z.literal('')),
  // projectId is optional and can be any string (will be validated in service)
  // If it's not a valid ObjectId, it will be ignored
  projectId: z.string().optional().or(z.literal('')),
  costCentreId: z.string().optional().or(z.literal('')),
  projectName: z.string().optional(),
  notes: z.string().optional(),
  // Advance cash (report-level)
  advanceAppliedAmount: z.number().min(0).optional(),
  advanceCurrency: z.string().optional(),
  // Use coerce to handle various datetime formats, then validate
  fromDate: z.string().refine(
    (val) => {
      const date = new Date(val);
      return !isNaN(date.getTime());
    },
    { message: 'Invalid datetime format for fromDate' }
  ),
  toDate: z.string().refine(
    (val) => {
      const date = new Date(val);
      return !isNaN(date.getTime());
    },
    { message: 'Invalid datetime format for toDate' }
  ),
}).refine((data) => new Date(data.fromDate) <= new Date(data.toDate), {
  message: 'End date cannot be earlier than start date',
  path: ['toDate'],
});

export const updateReportSchema = z.object({
  name: z.string().min(1).optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  costCentreId: z.string().optional().or(z.literal('')).nullable(),
  notes: z.string().optional(),
  // Advance cash (report-level)
  advanceAppliedAmount: z.number().min(0).optional(),
  advanceCurrency: z.string().optional(),
  // Accept YYYY-MM-DD format (calendar dates) or ISO datetime strings
  fromDate: z.string().refine(
    (val) => {
      if (!val) return true; // Optional
      const date = new Date(val);
      return !isNaN(date.getTime());
    },
    { message: 'Invalid datetime format for fromDate' }
  ).optional(),
  toDate: z.string().refine(
    (val) => {
      if (!val) return true; // Optional
      const date = new Date(val);
      return !isNaN(date.getTime());
    },
    { message: 'Invalid datetime format for toDate' }
  ).optional(),
}).refine((data) => {
  if (data.fromDate && data.toDate) {
    return new Date(data.fromDate) <= new Date(data.toDate);
  }
  return true;
}, {
  message: 'End date cannot be earlier than start date',
  path: ['toDate'],
});

export const submitReportSchema = z.object({
  advanceCashId: z.string().optional(), // Voucher ID to use for this report
  advanceAmount: z.number().min(0).optional(), // Amount to use from the voucher
});

export const reportActionSchema = z.object({
  action: z.enum(['approve', 'reject', 'request_changes']),
  comment: z.string().optional(),
});

// Expense DTOs
export const createExpenseSchema = z.object({
  vendor: z.string().min(1),
  categoryId: z.string().optional(),
  costCentreId: z.string().optional(), // Cost Centre is optional
  projectId: z.string().optional(),
  amount: z.number().min(0), // Allow 0 for DRAFT expenses (will be updated after OCR)
  currency: z.string().default('INR'),
  // Use lenient validation for expenseDate - accepts any valid date string
  expenseDate: z.string().refine(
    (val) => {
      const date = new Date(val);
      return !isNaN(date.getTime());
    },
    { message: 'Invalid datetime format for expenseDate' }
  ),
  source: z.nativeEnum(ExpenseSource),
  notes: z.string().optional(),
  receiptId: z.string().optional(), // Receipt ID to link to expense (e.g., source PDF/Excel document)
  // Advance cash (imprest) - intended application, actual deduction occurs on final approval
  advanceAppliedAmount: z.number().min(0).optional(),
  // Invoice fields for duplicate detection
  invoiceId: z.string().optional(),
  invoiceDate: z.string().refine(
    (val) => {
      if (!val) return true; // Optional field
      const date = new Date(val);
      return !isNaN(date.getTime());
    },
    { message: 'Invalid datetime format for invoiceDate' }
  ).optional(),
});

export const updateExpenseSchema = z.object({
  vendor: z.string().min(1).optional(),
  categoryId: z.string().optional(),
  costCentreId: z.string().optional().nullable(), // Cost Centre is optional and can be null
  projectId: z.string().optional(),
  amount: z.number().positive().optional(),
  currency: z.string().optional(),
  // Use lenient validation for expenseDate - accepts any valid date string
  expenseDate: z.string().refine(
    (val) => {
      const date = new Date(val);
      return !isNaN(date.getTime());
    },
    { message: 'Invalid datetime format for expenseDate' }
  ).optional(),
  notes: z.string().optional(),
  // Advance cash (imprest)
  advanceAppliedAmount: z.number().min(0).optional(),
  // Invoice fields for duplicate detection
  invoiceId: z.string().optional().nullable(),
  invoiceDate: z.string().refine(
    (val) => {
      if (!val) return true; // Optional field
      const date = new Date(val);
      return !isNaN(date.getTime());
    },
    { message: 'Invalid datetime format for invoiceDate' }
  ).optional().nullable(),
});

// Receipt DTOs
export const uploadIntentSchema = z.object({
  filename: z.string().optional(),
  mimeType: z.string(),
  sizeBytes: z.number().positive().optional(),
});

// Bulk Document Upload DTOs
export const bulkDocumentUploadIntentSchema = z.object({
  filename: z.string().min(1, 'Filename is required'),
  mimeType: z.string().min(1, 'MimeType is required'),
  sizeBytes: z.number().positive().optional(),
  reportId: z.string().min(1, 'Report ID is required'),
});

export const bulkDocumentConfirmSchema = z.object({
  storageKey: z.string().min(1, 'Storage key is required'),
  mimeType: z.string().min(1, 'MimeType is required'),
  reportId: z.string().min(1, 'Report ID is required'),
  receiptId: z.string().optional(), // Receipt ID for linking document to expenses
  skipExpenseCreation: z.boolean().optional().default(false), // Skip auto-creating expense drafts
});

// Batch receipt upload (multiple images as one unit - batch-first processing)
const batchReceiptItemSchema = z.object({
  filename: z.string().optional(),
  mimeType: z.string().min(1),
  sizeBytes: z.number().positive().optional(),
});

export const batchUploadIntentSchema = z.object({
  reportId: z.string().min(1, 'Report ID is required'),
  batchId: z.string().min(1, 'Batch ID is required'),
  files: z.array(batchReceiptItemSchema).min(1).max(50),
});

export const batchUploadConfirmItemSchema = z.object({
  receiptId: z.string().min(1),
  storageKey: z.string().min(1),
  mimeType: z.string().min(1),
});

export const batchUploadConfirmSchema = z.object({
  reportId: z.string().min(1, 'Report ID is required'),
  batchId: z.string().min(1, 'Batch ID is required'),
  receipts: z.array(batchUploadConfirmItemSchema).min(1).max(50),
});

// Query DTOs - Base schema with both limit and pageSize support
const paginationBaseSchema = z.object({
  page: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 1)),
  pageSize: z.string().optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
});

// Apply transformation to normalize limit/pageSize
export const paginationSchema = paginationBaseSchema.transform((data) => {
  // Use limit if provided, otherwise use pageSize, default to 20 if neither provided
  const pageSize = data.limit ?? data.pageSize ?? 20;
  return {
    page: data.page,
    pageSize: pageSize,
  };
});

export const reportFiltersSchema = paginationBaseSchema.extend({
  status: z.nativeEnum(ExpenseReportStatus).optional(),
  from: z.string().optional(), // YYYY-MM-DD or ISO date string
  to: z.string().optional(),
  projectId: z.string().optional(),
  userId: z.string().optional(),
  includeRejected: z.coerce.boolean().optional(),
}).transform((data) => {
  const pageSize = data.limit ?? data.pageSize ?? 20;
  return {
    page: data.page,
    pageSize: pageSize,
    status: data.status,
    from: data.from,
    to: data.to,
    projectId: data.projectId,
    userId: data.userId,
    includeRejected: data.includeRejected,
  };
});

export const expenseFiltersSchema = paginationBaseSchema.extend({
  status: z.nativeEnum(ExpenseStatus).optional(),
  categoryId: z.string().optional(),
  costCentreId: z.string().optional(), // Filter by cost centre
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD format
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD format
  q: z.string().optional(),
  reportId: z.string().optional(),
  excludeRejectedReports: z.coerce.boolean().optional(), // When true, exclude expenses whose report status is REJECTED (so dashboard/expenses totals don't count them)
}).transform((data) => {
  // Use limit if provided, otherwise use pageSize, default to 20 if neither provided
  const pageSize = data.limit ?? data.pageSize ?? 20;
  return {
    page: data.page,
    pageSize: pageSize,
    status: data.status,
    categoryId: data.categoryId,
    costCentreId: data.costCentreId,
    from: data.from,
    to: data.to,
    q: data.q,
    reportId: data.reportId,
    excludeRejectedReports: data.excludeRejectedReports,
  };
});

export const exportQuerySchema = z.object({
  format: z.nativeEnum(ExportFormat).default(ExportFormat.XLSX),
});

// Bulk CSV Export Filters Schema
export const bulkCsvExportFiltersSchema = z.object({
  financialYear: z.string().optional(), // e.g., "2024-25" or "FY2024-25"
  costCentreId: z.string().optional(),
  projectId: z.string().optional(),
  status: z.nativeEnum(ExpenseReportStatus).optional(),
  companyId: z.string().optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
});

/** Project (site) wise reports list export - single project only, Excel or PDF */
export const reportsListExportSchema = z.object({
  projectId: z.string().min(1, 'projectId is required for project-wise export'),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.nativeEnum(ExpenseReportStatus).optional(),
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
});

// Company DTOs
export const createCompanySchema = z.object({
  name: z.string().min(1, 'Company name is required').trim(),
  location: z.string().trim().optional(),
  type: z.enum(['Finance', 'IT', 'Healthcare', 'Retail', 'Manufacturing', 'Consulting', 'Education', 'Other']).optional(),
  status: z.enum(['active', 'trial', 'suspended', 'inactive']).optional().default('active'),
  plan: z.enum(['free', 'basic', 'professional', 'enterprise']).optional().default('basic'),
  domain: z.string().trim().toLowerCase().optional(),
}).passthrough().superRefine((data, ctx) => {
  // Ensure this is NOT a company admin creation request - reject if email/password are present
  if ((data as any).email || (data as any).password) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Company creation does not require email or password fields. Use /companies/:id/admins to create company admins.',
      path: ['email'],
    });
  }
});

export const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  location: z.string().optional(),
  type: z.enum(['Finance', 'IT', 'Healthcare', 'Retail', 'Manufacturing', 'Consulting', 'Education', 'Other']).optional(),
  status: z.enum(['active', 'trial', 'suspended', 'inactive']).optional(),
  plan: z.enum(['free', 'basic', 'professional', 'enterprise']).optional(),
  domain: z.string().optional(),
});

// Company Admin DTOs
export const createCompanyAdminSchema = z.object({
  email: z.string().email('Valid email is required').trim().toLowerCase(),
  name: z.string().min(1, 'Name is required').trim(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export const updateCompanyAdminSchema = z.object({
  name: z.string().min(1, 'Name is required').trim().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const resetCompanyAdminPasswordSchema = z.object({
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

// Department DTOs
export const createDepartmentSchema = z.object({
  name: z.string().min(1, 'Department name is required').trim(),
  code: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  headId: z.string().optional(),
});

export const updateDepartmentSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  headId: z.string().optional(),
});

// Type exports
export type LoginDto = z.infer<typeof loginSchema>;
export type RefreshTokenDto = z.infer<typeof refreshTokenSchema>;
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
export type CreateUserDto = z.infer<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;
export type CreateProjectDto = z.infer<typeof createProjectSchema>;
export type UpdateProjectDto = z.infer<typeof updateProjectSchema>;
export type CreateCategoryDto = z.infer<typeof createCategorySchema>;
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;
export type CreateReportDto = z.infer<typeof createReportSchema>;
export type UpdateReportDto = z.infer<typeof updateReportSchema>;
export type CreateExpenseDto = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseDto = z.infer<typeof updateExpenseSchema>;
export type UploadIntentDto = z.infer<typeof uploadIntentSchema>;
export type ReportFiltersDto = z.infer<typeof reportFiltersSchema>;
export type ExpenseFiltersDto = z.infer<typeof expenseFiltersSchema>;
export type ExportQueryDto = z.infer<typeof exportQuerySchema>;
export type CreateCompanyDto = z.infer<typeof createCompanySchema>;
export type UpdateCompanyDto = z.infer<typeof updateCompanySchema>;
export type CreateCompanyAdminDto = z.infer<typeof createCompanyAdminSchema>;
export type UpdateCompanyAdminDto = z.infer<typeof updateCompanyAdminSchema>;
export type ResetCompanyAdminPasswordDto = z.infer<typeof resetCompanyAdminPasswordSchema>;
export type CreateDepartmentDto = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentDto = z.infer<typeof updateDepartmentSchema>;
export type CreateCostCentreDto = z.infer<typeof createCostCentreSchema>;
export type UpdateCostCentreDto = z.infer<typeof updateCostCentreSchema>;
export type BulkDocumentUploadIntentDto = z.infer<typeof bulkDocumentUploadIntentSchema>;
export type BulkDocumentConfirmDto = z.infer<typeof bulkDocumentConfirmSchema>;


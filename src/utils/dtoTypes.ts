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
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string(),
});

// User DTOs
export const updateProfileSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  companyId: z.string().optional(),
  departmentId: z.string().optional(),
});

export const createUserSchema = z.object({
  email: z.string().email('Valid email is required').trim().toLowerCase(),
  name: z.string().min(1, 'Name is required').trim(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  phone: z.string().optional(),
  role: z.enum(['EMPLOYEE', 'MANAGER', 'BUSINESS_HEAD'], {
    errorMap: () => ({ message: 'Role must be EMPLOYEE, MANAGER, or BUSINESS_HEAD' })
  }),
  companyId: z.string().optional(),
  managerId: z.string().optional(),
  departmentId: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional().default('ACTIVE'),
});

export const updateUserSchema = z.object({
  name: z.string().min(1, 'Name is required').trim().optional(),
  email: z.string().email('Valid email is required').trim().toLowerCase().optional(),
  role: z.enum(['EMPLOYEE', 'MANAGER', 'BUSINESS_HEAD']).optional(),
  managerId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  phone: z.string().optional().nullable(),
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
  name: z.string().min(1),
  code: z.string().optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().optional(),
});

// Expense Report DTOs
export const createReportSchema = z.object({
  name: z.string().min(1),
  // projectId is optional and can be any string (will be validated in service)
  // If it's not a valid ObjectId, it will be ignored
  projectId: z.string().optional().or(z.literal('')),
  projectName: z.string().optional(),
  notes: z.string().optional(),
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
  message: 'fromDate must be before or equal to toDate',
});

export const updateReportSchema = z.object({
  name: z.string().min(1).optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  notes: z.string().optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
});

export const reportActionSchema = z.object({
  action: z.enum(['approve', 'reject', 'request_changes']),
  comment: z.string().optional(),
});

// Expense DTOs
export const createExpenseSchema = z.object({
  vendor: z.string().min(1),
  categoryId: z.string().optional(),
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
});

export const updateExpenseSchema = z.object({
  vendor: z.string().min(1).optional(),
  categoryId: z.string().optional(),
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
});

// Receipt DTOs
export const uploadIntentSchema = z.object({
  filename: z.string().optional(),
  mimeType: z.string(),
  sizeBytes: z.number().positive().optional(),
});

// Query DTOs
export const paginationSchema = z.object({
  page: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 1)),
  pageSize: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 20)),
});

export const reportFiltersSchema = paginationSchema.extend({
  status: z.nativeEnum(ExpenseReportStatus).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  projectId: z.string().optional(),
  userId: z.string().optional(),
});

export const expenseFiltersSchema = paginationSchema.extend({
  status: z.nativeEnum(ExpenseStatus).optional(),
  categoryId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().optional(),
  reportId: z.string().optional(),
});

export const exportQuerySchema = z.object({
  format: z.nativeEnum(ExportFormat).default(ExportFormat.XLSX),
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


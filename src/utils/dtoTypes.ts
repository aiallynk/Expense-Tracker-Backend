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
  notes: z.string().optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
});

// Expense DTOs
export const createExpenseSchema = z.object({
  vendor: z.string().min(1),
  categoryId: z.string(),
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
  mimeType: z.string(),
  sizeBytes: z.number().positive(),
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

// Type exports
export type LoginDto = z.infer<typeof loginSchema>;
export type RefreshTokenDto = z.infer<typeof refreshTokenSchema>;
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
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


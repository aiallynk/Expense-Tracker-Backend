export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  COMPANY_ADMIN = 'COMPANY_ADMIN',
  ADMIN = 'ADMIN',
  BUSINESS_HEAD = 'BUSINESS_HEAD',
  MANAGER = 'MANAGER',
  EMPLOYEE = 'EMPLOYEE',
  ACCOUNTANT = 'ACCOUNTANT',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export enum ExpenseReportStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  CHANGES_REQUESTED = 'CHANGES_REQUESTED',
  MANAGER_APPROVED = 'MANAGER_APPROVED',
  BH_APPROVED = 'BH_APPROVED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum ExpenseStatus {
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum ExpenseSource {
  SCANNED = 'SCANNED',
  MANUAL = 'MANUAL',
}

export enum OcrJobStatus {
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum NotificationPlatform {
  ANDROID = 'android',
  IOS = 'ios',
  WEB = 'web',
}

export enum AuditAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  STATUS_CHANGE = 'STATUS_CHANGE',
  IMPERSONATE = 'IMPERSONATE',
}

export enum ExportFormat {
  XLSX = 'xlsx',
  CSV = 'csv',
  PDF = 'pdf',
}

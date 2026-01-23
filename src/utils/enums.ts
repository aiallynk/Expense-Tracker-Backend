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
  PENDING_APPROVAL_L1 = 'PENDING_APPROVAL_L1',
  PENDING_APPROVAL_L2 = 'PENDING_APPROVAL_L2',
  PENDING_APPROVAL_L3 = 'PENDING_APPROVAL_L3',
  PENDING_APPROVAL_L4 = 'PENDING_APPROVAL_L4',
  PENDING_APPROVAL_L5 = 'PENDING_APPROVAL_L5',
  MANAGER_APPROVED = 'MANAGER_APPROVED', // Keep for backward compatibility
  BH_APPROVED = 'BH_APPROVED', // Keep for backward compatibility
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

export enum ReceiptStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum ReceiptFailureReason {
  TIMEOUT = 'TIMEOUT',
  UNREADABLE = 'UNREADABLE',
  API_ERROR = 'API_ERROR',
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
  BACKUP_CREATED = 'BACKUP_CREATED',
  BACKUP_RESTORED = 'BACKUP_RESTORED',
  BACKUP_DELETED = 'BACKUP_DELETED',
}

export enum ExportFormat {
  XLSX = 'xlsx',
  CSV = 'csv',
  PDF = 'pdf',
}

export enum BroadcastTargetType {
  ALL_USERS = 'ALL_USERS',
  COMPANY = 'COMPANY',
  ROLE = 'ROLE', // Future use
}
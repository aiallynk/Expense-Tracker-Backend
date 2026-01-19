/**
 * Common utility functions for migrations
 */

/**
 * Convert MongoDB ObjectId to UUID string (deterministic)
 * @param {ObjectId|string} objectId - MongoDB ObjectId
 * @returns {string} UUID string
 */
function objectIdToUuid(objectId) {
  if (!objectId) return null;
  const hex = objectId.toString();
  // Convert 24-char hex to UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (32 hex digits total)
  // Use first 24 chars and pad with zeros for remaining 8 hex digits
  // Format: 8-4-4-4-12 hex digits
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 24)}${'0'.repeat(8)}`;
}

/**
 * Convert array of ObjectIds to UUIDs
 */
function objectIdsToUuids(objectIds) {
  if (!objectIds || !Array.isArray(objectIds)) return null;
  return objectIds.map(id => objectIdToUuid(id)).filter(id => id !== null);
}

/**
 * Map MongoDB status enum to Prisma enum (uppercase)
 */
function mapStatus(status) {
  if (!status) return null;
  const statusMap = {
    'active': 'ACTIVE',
    'trial': 'TRIAL',
    'suspended': 'SUSPENDED',
    'inactive': 'INACTIVE',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

/**
 * Map MongoDB plan enum to Prisma enum (uppercase)
 */
function mapPlan(plan) {
  if (!plan) return null;
  const planMap = {
    'free': 'FREE',
    'basic': 'BASIC',
    'professional': 'PROFESSIONAL',
    'enterprise': 'ENTERPRISE',
  };
  return planMap[plan.toLowerCase()] || plan.toUpperCase();
}

/**
 * Map MongoDB user role enum to Prisma enum (uppercase)
 */
function mapUserRole(role) {
  if (!role) return 'EMPLOYEE';
  const roleMap = {
    'super_admin': 'SUPER_ADMIN',
    'company_admin': 'COMPANY_ADMIN',
    'admin': 'ADMIN',
    'business_head': 'BUSINESS_HEAD',
    'manager': 'MANAGER',
    'employee': 'EMPLOYEE',
    'accountant': 'ACCOUNTANT',
  };
  return roleMap[role.toLowerCase()] || role.toUpperCase();
}

/**
 * Map MongoDB user status enum to Prisma enum (uppercase)
 */
function mapUserStatus(status) {
  if (!status) return 'ACTIVE';
  const statusMap = {
    'active': 'ACTIVE',
    'inactive': 'INACTIVE',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

/**
 * Map MongoDB expense status enum to Prisma enum (uppercase)
 */
function mapExpenseStatus(status) {
  if (!status) return 'DRAFT';
  const statusMap = {
    'draft': 'DRAFT',
    'pending': 'PENDING',
    'approved': 'APPROVED',
    'rejected': 'REJECTED',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

/**
 * Map MongoDB expense source enum to Prisma enum (uppercase)
 */
function mapExpenseSource(source) {
  if (!source) return 'MANUAL';
  const sourceMap = {
    'scanned': 'SCANNED',
    'manual': 'MANUAL',
  };
  return sourceMap[source.toLowerCase()] || source.toUpperCase();
}

/**
 * Map MongoDB expense report status enum to Prisma enum (uppercase)
 */
function mapExpenseReportStatus(status) {
  if (!status) return 'DRAFT';
  const statusMap = {
    'draft': 'DRAFT',
    'submitted': 'SUBMITTED',
    'changes_requested': 'CHANGES_REQUESTED',
    'pending_approval_l1': 'PENDING_APPROVAL_L1',
    'pending_approval_l2': 'PENDING_APPROVAL_L2',
    'pending_approval_l3': 'PENDING_APPROVAL_L3',
    'pending_approval_l4': 'PENDING_APPROVAL_L4',
    'pending_approval_l5': 'PENDING_APPROVAL_L5',
    'approved': 'APPROVED',
    'rejected': 'REJECTED',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

/**
 * Map MongoDB OCR job status enum to Prisma enum (uppercase)
 */
function mapOcrJobStatus(status) {
  if (!status) return 'QUEUED';
  const statusMap = {
    'queued': 'QUEUED',
    'processing': 'PROCESSING',
    'completed': 'COMPLETED',
    'failed': 'FAILED',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

/**
 * Map MongoDB advance cash status enum to Prisma enum (uppercase)
 */
function mapAdvanceCashStatus(status) {
  if (!status) return 'ACTIVE';
  const statusMap = {
    'active': 'ACTIVE',
    'settled': 'SETTLED',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

/**
 * Map MongoDB project status enum to Prisma enum (uppercase)
 */
function mapProjectStatus(status) {
  if (!status) return 'ACTIVE';
  const statusMap = {
    'active': 'ACTIVE',
    'inactive': 'INACTIVE',
    'completed': 'COMPLETED',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

/**
 * Map MongoDB role type enum to Prisma enum (uppercase)
 */
function mapRoleType(type) {
  if (!type) return 'CUSTOM';
  const typeMap = {
    'system': 'SYSTEM',
    'custom': 'CUSTOM',
  };
  return typeMap[type.toLowerCase()] || type.toUpperCase();
}

/**
 * Map MongoDB category status enum to Prisma enum (uppercase)
 */
function mapCategoryStatus(status) {
  if (!status) return 'ACTIVE';
  const statusMap = {
    'active': 'ACTIVE',
    'inactive': 'INACTIVE',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

/**
 * Map MongoDB cost centre status enum to Prisma enum (uppercase)
 */
function mapCostCentreStatus(status) {
  if (!status) return 'ACTIVE';
  const statusMap = {
    'active': 'ACTIVE',
    'inactive': 'INACTIVE',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

/**
 * Map MongoDB department status enum to Prisma enum (uppercase)
 */
function mapDepartmentStatus(status) {
  if (!status) return 'ACTIVE';
  const statusMap = {
    'active': 'ACTIVE',
    'inactive': 'INACTIVE',
  };
  return statusMap[status.toLowerCase()] || status.toUpperCase();
}

module.exports = {
  objectIdToUuid,
  objectIdsToUuids,
  mapStatus,
  mapPlan,
  mapUserRole,
  mapUserStatus,
  mapExpenseStatus,
  mapExpenseSource,
  mapExpenseReportStatus,
  mapOcrJobStatus,
  mapAdvanceCashStatus,
  mapProjectStatus,
  mapRoleType,
  mapCategoryStatus,
  mapCostCentreStatus,
  mapDepartmentStatus,
};

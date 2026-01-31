import { getIO, emitToSuperAdmin } from './socketServer';
import { logger } from '../config/logger';

// Real-time event types for super admin
export enum SuperAdminEvent {
  DASHBOARD_STATS_UPDATE = 'super-admin:dashboard-stats-update',
  COMPANY_CREATED = 'super-admin:company-created',
  COMPANY_UPDATED = 'super-admin:company-updated',
  COMPANY_DELETED = 'super-admin:company-deleted',
  SUBSCRIPTION_PLAN_UPDATED = 'super-admin:subscription-plan-updated',
  SYSTEM_ANALYTICS_UPDATE = 'super-admin:system-analytics-update',
  SYSTEM_ANALYTICS_REQUEST = 'super-admin:system-analytics-request',
  LOG_ENTRY = 'super-admin:log-entry',
  SETTINGS_UPDATED = 'super-admin:settings-updated',
  BACKUP_CREATED = 'super-admin:backup-created',
  BACKUP_RESTORED = 'super-admin:backup-restored',
}

// Emit dashboard stats update
export const emitDashboardStatsUpdate = (stats: any) => {
  emitToSuperAdmin(SuperAdminEvent.DASHBOARD_STATS_UPDATE, stats);
  logger.debug('Emitted dashboard stats update');
};

// Emit company events
export const emitCompanyCreated = (company: any) => {
  emitToSuperAdmin(SuperAdminEvent.COMPANY_CREATED, company);
  logger.debug(`Emitted company created: ${company.id}`);
};

export const emitCompanyUpdated = (company: any) => {
  emitToSuperAdmin(SuperAdminEvent.COMPANY_UPDATED, company);
  logger.debug(`Emitted company updated: ${company.id}`);
};

export const emitCompanyDeleted = (companyId: string) => {
  emitToSuperAdmin(SuperAdminEvent.COMPANY_DELETED, { companyId });
  logger.debug(`Emitted company deleted: ${companyId}`);
};

// Emit subscription plan updates
export const emitSubscriptionPlanUpdated = (plan: any) => {
  emitToSuperAdmin(SuperAdminEvent.SUBSCRIPTION_PLAN_UPDATED, plan);
  logger.debug(`Emitted subscription plan updated: ${plan.id}`);
};

// Emit system analytics updates
export const emitSystemAnalyticsUpdate = (analytics: any) => {
  emitToSuperAdmin(SuperAdminEvent.SYSTEM_ANALYTICS_UPDATE, analytics);
  logger.debug('Emitted system analytics update');
};

// Emit log entries
export const emitLogEntry = (log: any) => {
  emitToSuperAdmin(SuperAdminEvent.LOG_ENTRY, log);
  logger.debug('Emitted log entry');
};

// Emit settings updates
export const emitSettingsUpdated = (settings: any) => {
  emitToSuperAdmin(SuperAdminEvent.SETTINGS_UPDATED, settings);
  logger.debug('Emitted settings updated');
};

// Emit backup events
export const emitBackupCreated = (backup: any) => {
  emitToSuperAdmin(SuperAdminEvent.BACKUP_CREATED, backup);
  logger.debug(`Emitted backup created: ${backup.id}`);
};

export const emitBackupRestored = (backupId: string) => {
  emitToSuperAdmin(SuperAdminEvent.BACKUP_RESTORED, { backupId });
  logger.debug(`Emitted backup restored: ${backupId}`);
};

/**
 * Emit maintenance mode logout to all non-super-admin users
 * This will trigger logout on all active sessions except super admin
 */
export const emitMaintenanceModeLogout = (userId?: string) => {
  const io = getIO();
  if (!io) {
    logger.warn('Socket.IO not initialized');
    return;
  }

  try {
    // If userId is provided, emit to specific user
    if (userId) {
      io.to(`user:${userId}`).emit('maintenance-mode-logout', {
        message: "You'll be logged out for a while due to maintenance mode. Please try again later.",
        maintenanceMode: true,
      });
      logger.debug(`Emitted maintenance mode logout to user ${userId}`);
    } else {
      // Emit to all users except super-admin room
      // Emit to all role-based rooms except SUPER_ADMIN
      const roles = ['MANAGER', 'BUSINESS_HEAD', 'EMPLOYEE', 'COMPANY_ADMIN', 'ADMIN', 'ACCOUNTANT'];
      roles.forEach(role => {
        io.to(`role:${role}`).emit('maintenance-mode-logout', {
          message: "You'll be logged out for a while due to maintenance mode. Please try again later.",
          maintenanceMode: true,
        });
      });
      logger.debug('Emitted maintenance mode logout to all non-super-admin users');
    }
  } catch (error) {
    logger.error({ error }, 'Error emitting maintenance mode logout');
  }
};

// Real-time event types for company admin
export enum CompanyAdminEvent {
  DASHBOARD_STATS_UPDATE = 'company-admin:dashboard-stats-update',
  USER_CREATED = 'company-admin:user-created',
  VOUCHER_UPDATED = 'company-admin:voucher-updated',
  USER_UPDATED = 'company-admin:user-updated',
  USER_DELETED = 'company-admin:user-deleted',
  REPORT_CREATED = 'company-admin:report-created',
  REPORT_UPDATED = 'company-admin:report-updated',
  EXPENSE_CREATED = 'company-admin:expense-created',
  EXPENSE_UPDATED = 'company-admin:expense-updated',
  NOTIFICATION_CREATED = 'company-admin:notification-created',
  NOTIFICATION_UPDATED = 'company-admin:notification-updated',
  NOTIFICATIONS_MARKED_READ = 'company-admin:notifications-marked-read',
}

// Real-time event types for manager
export enum ManagerEvent {
  DASHBOARD_STATS_UPDATE = 'manager:dashboard-stats-update',
  REPORT_SUBMITTED = 'manager:report-submitted',
  REPORT_APPROVED = 'manager:report-approved',
  REPORT_REJECTED = 'manager:report-rejected',
  EXPENSE_CREATED = 'manager:expense-created',
  EXPENSE_UPDATED = 'manager:expense-updated',
  TEAM_CREATED = 'manager:team-created',
  TEAM_UPDATED = 'manager:team-updated',
  TEAM_STATS_UPDATE = 'manager:team-stats-update',
}

// Helper to emit to company admin users
export const emitToCompanyAdmin = (companyId: string, event: string, data: any) => {
  const io = getIO();
  if (!io) {
    logger.warn('Socket.IO not initialized');
    return;
  }

  try {
    // Emit to all sockets in the company admin room
    io.to(`company-admin:${companyId}`).emit(event, data);
    logger.debug(`Emitted ${event} to company ${companyId}`);
  } catch (error) {
    logger.error({ error }, `Error emitting ${event}`);
  }
};

// Emit dashboard stats update for company admin
export const emitCompanyAdminDashboardUpdate = (companyId: string, stats: any) => {
  emitToCompanyAdmin(companyId, CompanyAdminEvent.DASHBOARD_STATS_UPDATE, stats);
  logger.debug(`Emitted company admin dashboard update for company ${companyId}`);
};

// Emit user created event for company admin
export const emitUserCreated = (companyId: string, user: any) => {
  emitToCompanyAdmin(companyId, CompanyAdminEvent.USER_CREATED, user);
  logger.debug(`Emitted user created event for company ${companyId}, user: ${user.id || user._id}`);
};

// Emit user updated event for company admin
export const emitUserUpdated = (companyId: string, user: any) => {
  emitToCompanyAdmin(companyId, CompanyAdminEvent.USER_UPDATED, user);
  logger.debug(`Emitted user updated event for company ${companyId}, user: ${user.id || user._id}`);
};

// Emit user deleted event for company admin
export const emitUserDeleted = (companyId: string, userId: string) => {
  emitToCompanyAdmin(companyId, CompanyAdminEvent.USER_DELETED, { userId });
  logger.debug(`Emitted user deleted event for company ${companyId}, user: ${userId}`);
};

// Emit voucher updated event to company admin
export const emitVoucherUpdated = (companyId: string, voucher: any) => {
  emitToCompanyAdmin(companyId, CompanyAdminEvent.VOUCHER_UPDATED, voucher);
  logger.debug(`Emitted voucher updated event for company ${companyId}, voucher: ${voucher.id || voucher._id}`);
};

// Helper to emit to a specific manager's socket
export const emitToManager = (managerId: string, event: string, data: any) => {
  const io = getIO();
  if (!io) {
    logger.warn('Socket.IO not initialized');
    return;
  }

  try {
    // Emit to manager's socket room
    io.to(`manager:${managerId}`).emit(event, data);
    logger.debug(`Emitted ${event} to manager ${managerId}`);
  } catch (error) {
    logger.error({ error, managerId, event }, `Error emitting ${event} to manager`);
  }
};

// Emit dashboard stats update for manager
export const emitManagerDashboardUpdate = async (managerId: string) => {
  try {
    const { ManagerService } = await import('../services/manager.service');
    const stats = await ManagerService.getManagerDashboardStats(managerId);
    emitToManager(managerId, ManagerEvent.DASHBOARD_STATS_UPDATE, stats);
  } catch (error) {
    logger.error({ error, managerId }, 'Error emitting manager dashboard update');
  }
};

// Emit report update to manager
export const emitManagerReportUpdate = (managerId: string, action: string, report: any) => {
  const event = action === 'approved' 
    ? ManagerEvent.REPORT_APPROVED 
    : action === 'rejected'
    ? ManagerEvent.REPORT_REJECTED
    : ManagerEvent.REPORT_SUBMITTED;
  
  emitToManager(managerId, event, report);
  logger.debug(`Emitted ${event} to manager ${managerId}, report: ${report._id}`);
};

// Emit team created event to manager
export const emitTeamCreated = (_companyId: string, team: any) => {
  if (team.managerId) {
    const managerId = typeof team.managerId === 'object' ? team.managerId._id?.toString() : team.managerId.toString();
    emitToManager(managerId, ManagerEvent.TEAM_CREATED, team);
    logger.debug(`Emitted team created to manager ${managerId}, team: ${team._id}`);
  }
};

// Emit team updated event to manager
export const emitTeamUpdated = (_companyId: string, team: any) => {
  if (team.managerId) {
    const managerId = typeof team.managerId === 'object' ? team.managerId._id?.toString() : team.managerId.toString();
    emitToManager(managerId, ManagerEvent.TEAM_UPDATED, team);
    // Also emit team stats update
    emitTeamStatsUpdate(managerId);
    logger.debug(`Emitted team updated to manager ${managerId}, team: ${team._id}`);
  }
};

// Emit team stats update to manager
export const emitTeamStatsUpdate = async (managerId: string) => {
  try {
    const { TeamsService } = await import('../services/teams.service');
    const stats = await TeamsService.getTeamStats(managerId);
    emitToManager(managerId, ManagerEvent.TEAM_STATS_UPDATE, stats);
    logger.debug(`Emitted team stats update to manager ${managerId}`);
  } catch (error) {
    logger.error({ error, managerId }, 'Error emitting team stats update');
  }
};

// Real-time event types for employees
export enum EmployeeEvent {
  EXPENSE_UPDATED = 'employee:expense-updated',
  EXPENSE_APPROVED = 'employee:expense-approved',
  EXPENSE_REJECTED = 'employee:expense-rejected',
  EXPENSE_CHANGES_REQUESTED = 'employee:expense-changes-requested',
  REPORT_UPDATED = 'employee:report-updated',
}

// Helper to emit to a specific user's socket (for employees)
export const emitToUser = (userId: string, event: string, data: any) => {
  const io = getIO();
  if (!io) {
    logger.warn('Socket.IO not initialized');
    return;
  }

  try {
    // Emit to user's socket room
    io.to(`user:${userId}`).emit(event, data);
    logger.debug(`Emitted ${event} to user ${userId}`);
  } catch (error) {
    logger.error({ error, userId, event }, `Error emitting ${event} to user`);
  }
};

// Emit expense update to employee
export const emitExpenseUpdateToEmployee = (userId: string, expense: any) => {
  emitToUser(userId, EmployeeEvent.EXPENSE_UPDATED, expense);
  logger.debug(`Emitted expense update to employee ${userId}, expense: ${expense._id || expense.id}`);
};

// Emit expense approved to employee
export const emitExpenseApprovedToEmployee = (userId: string, expense: any) => {
  emitToUser(userId, EmployeeEvent.EXPENSE_APPROVED, expense);
  logger.debug(`Emitted expense approved to employee ${userId}, expense: ${expense._id || expense.id}`);
};

// Emit expense rejected to employee
export const emitExpenseRejectedToEmployee = (userId: string, expense: any) => {
  emitToUser(userId, EmployeeEvent.EXPENSE_REJECTED, expense);
  logger.debug(`Emitted expense rejected to employee ${userId}, expense: ${expense._id || expense.id}`);
};

// Emit expense changes requested to employee
export const emitExpenseChangesRequestedToEmployee = (userId: string, expense: any) => {
  emitToUser(userId, EmployeeEvent.EXPENSE_CHANGES_REQUESTED, expense);
  logger.debug(`Emitted expense changes requested to employee ${userId}, expense: ${expense._id || expense.id}`);
};

// Receipt processing events
export enum ReceiptEvent {
  PROCESSING = 'receipt:processing',
  PROCESSED = 'receipt:processed',
  FAILED = 'receipt:failed',
  QUEUED = 'receipt:queued',
}

// Emit receipt queued event to user (when job is queued due to per-user limit)
export const emitReceiptQueued = (userId: string, receiptId: string, position: number) => {
  emitToUser(userId, ReceiptEvent.QUEUED, {
    receiptId,
    status: 'QUEUED',
    position,
  });
  logger.debug(`Emitted receipt:queued to user ${userId}, receipt: ${receiptId}, position: ${position}`);
};

// Emit receipt processing event to user (when OCR job starts)
export const emitReceiptProcessing = (userId: string, receiptId: string) => {
  emitToUser(userId, ReceiptEvent.PROCESSING, {
    receiptId,
    status: 'PROCESSING',
  });
  logger.debug(`Emitted receipt:processing to user ${userId}, receipt: ${receiptId}`);
};

/** Payload for receipt:processed socket event */
export interface ReceiptProcessedPayload {
  receiptId: string;
  status: 'COMPLETED' | 'FAILED';
  vendor?: string | null;
  date?: string | null;
  total?: number | null;
  currency?: string | null;
  invoiceId?: string | null;
  invoice_number?: string | null;
  notes?: string | null;
  lineItems?: Array<{ description: string; amount: number }> | null;
  reason?: 'TIMEOUT' | 'UNREADABLE' | 'API_ERROR';
  duplicateFlag?: 'POTENTIAL_DUPLICATE' | 'STRONG_DUPLICATE' | 'HARD_DUPLICATE' | null;
  duplicateReason?: string | null;
  categorySuggestion?: string | null;
  categoryId?: string;
  categoryUnidentified?: boolean;
  /** True if receipt is handwritten; user should recheck. */
  isHandwritten?: boolean;
  /** Field names to highlight for review (e.g. "date", "vendor", "total"). */
  doubtfulFields?: string[];
  /** True if date was ambiguous (e.g. dd-mm-yy) and user should confirm. */
  dateReviewRecommended?: boolean;
  /** Exchange rate if present on receipt. */
  exchangeRate?: number | null;
}

// Emit receipt processed event to user
export const emitReceiptProcessed = (
  userId: string,
  receiptId: string,
  data: ReceiptProcessedPayload
) => {
  emitToUser(userId, ReceiptEvent.PROCESSED, {
    ...data,
    receiptId, // Override receiptId from data to ensure consistency
  });
  logger.debug(`Emitted receipt:processed to user ${userId}, receipt: ${receiptId}, status: ${data.status}, duplicateFlag: ${data.duplicateFlag || 'none'}`);
};

// Notification events
export const NOTIFICATION_EVENT = 'notification:new';

// Emit notification to a specific user
export const emitNotificationToUser = (userId: string, notification: any) => {
  emitToUser(userId, NOTIFICATION_EVENT, notification);
  logger.debug(`Emitted notification to user ${userId}, notification: ${notification._id || notification.id}`);
};

// Emit notification to a specific role via Socket.IO (for real-time UI refresh only)
export const emitNotificationToRole = (role: string, notification: any) => {
  const io = getIO();
  if (!io) {
    logger.warn('Socket.IO not initialized');
    return;
  }

  try {
    // Emit to role-specific room
    io.to(`role:${role}`).emit(NOTIFICATION_EVENT, notification);
    logger.debug(`Emitted notification to role:${role}, notification: ${notification._id || notification.id}`);
  } catch (error) {
    logger.error({ error, role }, `Error emitting notification to role:${role}`);
  }
};

// DEPRECATED: Use emitNotificationToRole() instead
// This function is kept for backward compatibility but should not be used for delivery
// Socket.IO is ONLY for real-time UI refresh, NOT for notification delivery
export const emitNotificationToAll = (notification: any) => {
  logger.warn('emitNotificationToAll() is deprecated. Use emitNotificationToRole() for role-based notifications.');
  const io = getIO();
  if (!io) {
    logger.warn('Socket.IO not initialized');
    return;
  }

  try {
    io.emit(NOTIFICATION_EVENT, notification);
    logger.debug(`Emitted notification to all clients, notification: ${notification._id || notification.id}`);
  } catch (error) {
    logger.error({ error }, 'Error emitting notification to all');
  }
};


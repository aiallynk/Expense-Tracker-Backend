import { Router } from 'express';
import { z } from 'zod';

import { ActivityController } from '../controllers/activity.controller';
import { AdminController } from '../controllers/admin.controller';
import { BroadcastNotificationController } from '../controllers/broadcastNotification.controller';
import { NotificationBroadcastController } from '../controllers/notificationBroadcast.controller';
import { TestNotificationController } from '../controllers/testNotification.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireAdmin, requireRole } from '../middleware/role.middleware';
import {
  requireServiceAccountReadOnly,
  validateServiceAccountEndpoint,
} from '../middleware/serviceAccount.middleware';
import { validate } from '../middleware/validate.middleware';
import { NotificationBroadcastChannel, NotificationBroadcastStatus, NotificationBroadcastType } from '../models/NotificationBroadcast';
import { UserRole, BroadcastTargetType } from '../utils/enums';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Analytics endpoints (read-only) - allow service accounts
router.get('/summary/dashboard', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.getDashboard);
router.get('/summary/dashboard/filtered', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.getFilteredDashboard);
router.get('/summary/storage-growth', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.getStorageGrowth);
router.get('/analytics/expenses-daily', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.getExpensesDaily);
router.get('/analytics/ocr-daily', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.getOcrUsageDaily);
router.get('/export/csv', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.bulkCsvExport);
router.get('/export/excel', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.bulkExcelExport);

// Company Analytics (read-only) - allow service accounts
router.get('/companies', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.getCompaniesList);
router.get('/companies/:id/analytics', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.getCompanyAnalytics);
router.get('/companies/:id/mini-stats', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AdminController.getCompanyMiniStats);

// Other routes require admin role (no service accounts)
router.use(requireAdmin);

// Reports
router.get('/reports', AdminController.getAllReports);
router.post('/reports/:id/approve', AdminController.approveReport);
router.post('/reports/:id/reject', AdminController.rejectReport);
router.get('/reports/:id/export', AdminController.exportReport);

// Bulk Exports (Admin & Accountant only)
router.get('/export/csv', AdminController.bulkCsvExport);
router.get('/export/excel', AdminController.bulkExcelExport);

// Expenses
router.get('/expenses', AdminController.getAllExpenses);
router.post('/expenses/:id/approve', AdminController.approveExpense);
router.post('/expenses/:id/reject', AdminController.rejectExpense);

// Dashboard
router.get('/summary/dashboard', AdminController.getDashboard);
router.get('/summary/dashboard/filtered', AdminController.getFilteredDashboard);
router.get('/summary/storage-growth', AdminController.getStorageGrowth);
router.get('/analytics/expenses-daily', AdminController.getExpensesDaily);
router.get('/analytics/ocr-daily', AdminController.getOcrUsageDaily);

// Company Analytics
router.get('/companies/:id/analytics', AdminController.getCompanyAnalytics);
router.post('/companies/:id/analytics/rebuild', AdminController.rebuildCompanyAnalytics);
router.get('/companies/:id/mini-stats', AdminController.getCompanyMiniStats);

// Insight Detection (Admin only - triggers alerts)
router.post('/insights/detect/ocr-spike', AdminController.detectOCRSpike);
router.post('/insights/detect/api-abuse', AdminController.detectAPIAbuse);
router.post('/insights/check/storage-thresholds', AdminController.checkStorageThresholds);

// Cache Management (Admin only)
router.get('/cache/stats', AdminController.getCacheStats);
router.post('/cache/clear', AdminController.clearCache);

// Activity Logs
router.get('/activity', ActivityController.getActivityLogs);
router.get('/activity/recent', ActivityController.getRecentActivity);

// Test Notification (SUPER_ADMIN only) - FOR TESTING ONLY, uses loop-based approach
const testNotificationSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  body: z.string().min(1, 'Body is required'),
});

router.post(
  '/test/send-notification',
  requireRole(UserRole.SUPER_ADMIN),
  validate(testNotificationSchema),
  TestNotificationController.sendTestNotification
);

// Broadcast Notification (SUPER_ADMIN only) - PRODUCTION-GRADE, uses FCM Topics
const broadcastNotificationSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  body: z.string().min(1, 'Body is required'),
  targetType: z.nativeEnum(BroadcastTargetType),
  companyId: z.string().optional(),
  role: z.string().optional(),
}).refine((data) => {
  // Validate companyId is provided when targetType is COMPANY
  if (data.targetType === BroadcastTargetType.COMPANY && !data.companyId) {
    return false;
  }
  // Validate role is provided when targetType is ROLE
  if (data.targetType === BroadcastTargetType.ROLE && !data.role) {
    return false;
  }
  return true;
}, {
  message: 'companyId is required when targetType is COMPANY, role is required when targetType is ROLE',
});

router.post(
  '/broadcast-notification',
  requireRole(UserRole.SUPER_ADMIN),
  validate(broadcastNotificationSchema),
  BroadcastNotificationController.sendBroadcastNotification
);

// ===================== Super Admin Notification Broadcast System (V2) =====================
// POST /api/v1/admin/notifications/broadcast
const notificationBroadcastV2Schema = z.object({
  title: z.string().min(1, 'Title is required'),
  message: z.string().min(1, 'Message is required'),
  type: z.nativeEnum(NotificationBroadcastType),
  targetType: z.enum([BroadcastTargetType.ALL_USERS, BroadcastTargetType.COMPANY]),
  companyId: z.string().optional(),
  channels: z.array(z.nativeEnum(NotificationBroadcastChannel)).min(1, 'At least one channel is required'),
  scheduledAt: z.union([z.string().datetime(), z.null()]).optional(),
}).refine((data) => {
  if (data.targetType === BroadcastTargetType.COMPANY && !data.companyId) return false;
  return true;
}, { message: 'companyId is required when targetType is COMPANY' });

router.post(
  '/notifications/broadcast',
  requireRole(UserRole.SUPER_ADMIN),
  validate(notificationBroadcastV2Schema),
  NotificationBroadcastController.create
);

// GET /api/v1/admin/notifications/broadcasts
const listBroadcastsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.nativeEnum(NotificationBroadcastStatus).optional(),
  targetType: z.enum([BroadcastTargetType.ALL_USERS, BroadcastTargetType.COMPANY]).optional(),
  companyId: z.string().optional(),
});

router.get(
  '/notifications/broadcasts',
  requireRole(UserRole.SUPER_ADMIN),
  validate(listBroadcastsSchema),
  NotificationBroadcastController.list
);

export default router;


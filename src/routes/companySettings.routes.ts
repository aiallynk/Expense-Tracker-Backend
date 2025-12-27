import { Router } from 'express';

import { ApprovalRulesController } from '../controllers/approvalRules.controller';
import { CompanyNotificationsController } from '../controllers/companyNotifications.controller';
import { CompanySettingsController } from '../controllers/companySettings.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { UserRole } from '../utils/enums';
// Import models to ensure they're registered with Mongoose
import '../models/ApprovalRule';
import '../models/CompanySettings';
import '../models/Notification';

const router = Router();

// All routes require authentication and COMPANY_ADMIN role
router.use(authMiddleware);
router.use(requireRole(UserRole.COMPANY_ADMIN));

// Company Settings routes
// GET /api/v1/company-admin/settings - Get company settings
router.get('/settings', CompanySettingsController.getSettings);

// PUT /api/v1/company-admin/settings - Update company settings
router.put('/settings', CompanySettingsController.updateSettings);

// POST /api/v1/company-admin/settings/reset - Reset settings to default
router.post('/settings/reset', CompanySettingsController.resetSettings);

// Approval Rules routes
// GET /api/v1/company-admin/approval-rules - Get all approval rules
router.get('/approval-rules', ApprovalRulesController.getApprovalRules);

// POST /api/v1/company-admin/approval-rules - Create approval rule
router.post('/approval-rules', ApprovalRulesController.createApprovalRule);

// PUT /api/v1/company-admin/approval-rules/:id - Update approval rule
router.put('/approval-rules/:id', ApprovalRulesController.updateApprovalRule);

// DELETE /api/v1/company-admin/approval-rules/:id - Delete approval rule
router.delete('/approval-rules/:id', ApprovalRulesController.deleteApprovalRule);

// Company Notifications routes
// GET /api/v1/company-admin/notifications - Get notifications
router.get('/notifications', CompanyNotificationsController.getNotifications);

// PUT /api/v1/company-admin/notifications/:id/read - Mark notification as read
router.put('/notifications/:id/read', CompanyNotificationsController.markAsRead);

// PUT /api/v1/company-admin/notifications/read-all - Mark all notifications as read
router.put('/notifications/read-all', CompanyNotificationsController.markAllAsRead);

export default router;


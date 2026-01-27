import { Router } from 'express';

import { ApprovalRulesController } from '../controllers/approvalRules.controller';
import { ApproverMappingController } from '../controllers/approverMapping.controller';
import { BrandingController } from '../controllers/branding.controller';
import { CompanyNotificationsController } from '../controllers/companyNotifications.controller';
import { CompanySettingsController } from '../controllers/companySettings.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireCompanyAdmin } from '../middleware/role.middleware';
// Import models to ensure they're registered with Mongoose
import '../models/ApprovalRule';
import '../models/ApproverMapping';
import '../models/CompanySettings';
import '../models/Notification';

const router = Router();

// All routes require authentication and COMPANY_ADMIN or SUPER_ADMIN role
router.use(authMiddleware);
router.use(requireCompanyAdmin);

// Company Settings routes
// GET /api/v1/company-admin/settings - Get company settings
router.get('/settings', CompanySettingsController.getSettings);

// PUT /api/v1/company-admin/settings - Update company settings
router.put('/settings', CompanySettingsController.updateSettings);

// PUT /api/v1/company-admin/settings/self-approval - Update self-approval policy only
router.put('/settings/self-approval', CompanySettingsController.updateSelfApprovalPolicy);

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

// DELETE /api/v1/company-admin/notifications - Clear all notifications for this company admin user
router.delete('/notifications', CompanyNotificationsController.clearAll);

// Approver Mapping routes
// GET /api/v1/company-admin/approver-mappings - Get all approver mappings
router.get('/approver-mappings', ApproverMappingController.getMappings);

// GET /api/v1/company-admin/approver-mappings/:userId - Get approver mapping for user
router.get('/approver-mappings/:userId', ApproverMappingController.getMappingByUserId);

// POST /api/v1/company-admin/approver-mappings - Create/update approver mapping
router.post('/approver-mappings', ApproverMappingController.upsertMapping);

// DELETE /api/v1/company-admin/approver-mappings/:userId - Delete approver mapping
router.delete('/approver-mappings/:userId', ApproverMappingController.deleteMapping);

// Branding routes
// POST /api/v1/company-admin/branding/logo/upload-intent - Create upload intent for logo
router.post('/branding/logo/upload-intent', BrandingController.createUploadIntent);

// POST /api/v1/company-admin/branding/logo/confirm-upload - Confirm logo upload
router.post('/branding/logo/confirm-upload', BrandingController.confirmUpload);

// GET /api/v1/company-admin/branding/logo - Get company logo URL
router.get('/branding/logo', BrandingController.getLogo);

// DELETE /api/v1/company-admin/branding/logo - Delete company logo
router.delete('/branding/logo', BrandingController.deleteLogo);

export default router;


import { Router } from 'express';

import { SuperAdminController } from '../controllers/superAdmin.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import {
  requireServiceAccountReadOnly,
  validateServiceAccountEndpoint,
} from '../middleware/serviceAccount.middleware';
import { validate } from '../middleware/validate.middleware';
import { createCompanySchema, updateCompanySchema } from '../utils/dtoTypes';
import { UserRole } from '../utils/enums';
// Import Company model to ensure it's registered with Mongoose
import '../models/Company';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Analytics endpoints (read-only) - allow service accounts
router.get('/dashboard/stats', requireServiceAccountReadOnly, validateServiceAccountEndpoint, SuperAdminController.getDashboardStats);
router.get('/system-analytics', requireServiceAccountReadOnly, validateServiceAccountEndpoint, SuperAdminController.getSystemAnalytics);
router.get('/system-analytics/detailed', requireServiceAccountReadOnly, validateServiceAccountEndpoint, SuperAdminController.getSystemAnalyticsDetailed);

// AI Usage Analytics (read-only)
router.get('/ai-usage/snapshot', requireServiceAccountReadOnly, validateServiceAccountEndpoint, SuperAdminController.getAiUsageSnapshot);
router.get('/ai-usage/summary', requireServiceAccountReadOnly, validateServiceAccountEndpoint, SuperAdminController.getAiUsageSummary);
router.get('/ai-usage/companies', requireServiceAccountReadOnly, validateServiceAccountEndpoint, SuperAdminController.getAiUsageTopCompanies);
router.get('/ai-usage/features', requireServiceAccountReadOnly, validateServiceAccountEndpoint, SuperAdminController.getAiUsageByFeature);
router.get('/ai-usage/models', requireServiceAccountReadOnly, validateServiceAccountEndpoint, SuperAdminController.getAiUsageByModel);
router.get('/ai-usage/trends', requireServiceAccountReadOnly, validateServiceAccountEndpoint, SuperAdminController.getAiUsageTrends);

// Other routes require SUPER_ADMIN role (no service accounts)
router.use(requireRole(UserRole.SUPER_ADMIN));

// Platform Stats
router.get('/platform/stats', SuperAdminController.getPlatformStats);

// Companies - IMPORTANT: Define exact routes before parameterized routes
router.get('/companies', SuperAdminController.getCompanies);
router.post('/companies', validate(createCompanySchema), SuperAdminController.createCompany);
router.get('/companies/:id', SuperAdminController.getCompanyById);
router.get('/companies/:id/analytics', SuperAdminController.getCompanyAnalytics);
router.get('/companies/:id/mini-stats', SuperAdminController.getCompanyMiniStats);
router.put('/companies/:id', validate(updateCompanySchema), SuperAdminController.updateCompany);
router.delete('/companies/:id', SuperAdminController.deleteCompany);

// Note: Company Admin routes have been moved to /api/v1/companies/:companyId/admins
// See companyAdmin.routes.ts for company admin CRUD operations

// Logs
router.get('/logs', SuperAdminController.getLogs);

// Backup & Restore
router.post('/backup/full', SuperAdminController.createFullBackup);
router.post('/backup/company/:companyId', SuperAdminController.createCompanyBackup);
router.get('/backups', SuperAdminController.getBackups);
router.post('/backups/:id/restore', SuperAdminController.restoreBackup);
router.get('/backups/:id/download', SuperAdminController.downloadBackup);
router.delete('/backup/:id', SuperAdminController.deleteBackup);

// Global Settings
router.get('/settings', SuperAdminController.getGlobalSettings);
router.patch('/settings', SuperAdminController.updateGlobalSettings);
router.post('/settings/reset', SuperAdminController.resetGlobalSettings);

export default router;


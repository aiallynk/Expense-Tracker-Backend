import { Router } from 'express';

import { SuperAdminController } from '../controllers/superAdmin.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import { createCompanySchema, updateCompanySchema } from '../utils/dtoTypes';
import { UserRole } from '../utils/enums';
// Import Company model to ensure it's registered with Mongoose
import '../models/Company';

const router = Router();

// All routes require authentication and SUPER_ADMIN role
router.use(authMiddleware);
router.use(requireRole(UserRole.SUPER_ADMIN));

// Dashboard
router.get('/dashboard/stats', SuperAdminController.getDashboardStats);

// System Analytics
router.get('/system-analytics', SuperAdminController.getSystemAnalytics);
router.get('/system-analytics/detailed', SuperAdminController.getSystemAnalyticsDetailed);

// Platform Stats
router.get('/platform/stats', SuperAdminController.getPlatformStats);

// Companies - IMPORTANT: Define exact routes before parameterized routes
router.get('/companies', SuperAdminController.getCompanies);
router.post('/companies', validate(createCompanySchema), SuperAdminController.createCompany);
router.get('/companies/:id', SuperAdminController.getCompanyById);
router.put('/companies/:id', validate(updateCompanySchema), SuperAdminController.updateCompany);
router.delete('/companies/:id', SuperAdminController.deleteCompany);

// Note: Company Admin routes have been moved to /api/v1/companies/:companyId/admins
// See companyAdmin.routes.ts for company admin CRUD operations

// Logs
router.get('/logs', SuperAdminController.getLogs);

// Backup & Restore
router.post('/backup', SuperAdminController.createBackup);
router.get('/backups', SuperAdminController.getBackups);
router.post('/backups/:id/restore', SuperAdminController.restoreBackup);
router.get('/backups/:id/download', SuperAdminController.downloadBackup);

// Global Settings
router.get('/settings', SuperAdminController.getGlobalSettings);
router.patch('/settings', SuperAdminController.updateGlobalSettings);
router.post('/settings/reset', SuperAdminController.resetGlobalSettings);

export default router;


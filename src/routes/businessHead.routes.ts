import { Router } from 'express';

import { BusinessHeadController } from '../controllers/businessHead.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { UserRole } from '../utils/enums';

const router = Router();

// All routes require authentication and BUSINESS_HEAD role
router.use(authMiddleware);
router.use(requireRole(UserRole.BUSINESS_HEAD));

// Dashboard
router.get('/dashboard', BusinessHeadController.getDashboard);

// Managers
router.get('/managers', BusinessHeadController.getManagers);
router.get('/managers/:id', BusinessHeadController.getManagerDetails);

// Reports
router.get('/reports', BusinessHeadController.getCompanyReports);
router.get('/reports/pending', BusinessHeadController.getPendingReports);
router.get('/reports/:id', BusinessHeadController.getReportDetails);
router.post('/reports/:id/approve', BusinessHeadController.approveReport);
router.post('/reports/:id/reject', BusinessHeadController.rejectReport);
router.post('/reports/:id/request-changes', BusinessHeadController.requestReportChanges);

// Settings
router.get('/settings', BusinessHeadController.getSettings);
router.put('/settings', BusinessHeadController.updateSettings);

export default router;


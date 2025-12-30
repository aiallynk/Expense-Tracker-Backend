import { Router } from 'express';

import { AccountantController } from '../controllers/accountant.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import {
  requireServiceAccountReadOnly,
  validateServiceAccountEndpoint,
} from '../middleware/serviceAccount.middleware';
import { UserRole } from '../utils/enums';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Analytics endpoints (read-only) - allow service accounts
router.get('/dashboard', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AccountantController.getDashboard);
router.get('/expenses/department-wise', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AccountantController.getDepartmentWiseExpenses);
router.get('/expenses/project-wise', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AccountantController.getProjectWiseExpenses);
router.get('/expenses/cost-centre-wise', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AccountantController.getCostCentreWiseExpenses);
router.get('/export/csv', requireServiceAccountReadOnly, validateServiceAccountEndpoint, AccountantController.bulkCsvExport);

// Other routes require ACCOUNTANT role (no service accounts)
router.use(requireRole(UserRole.ACCOUNTANT));

// Dashboard
router.get('/dashboard', AccountantController.getDashboard);

// Reports (read-only)
router.get('/reports', AccountantController.getReports);
router.get('/reports/:id', AccountantController.getReportDetails);

// Expenses (read-only)
router.get('/expenses/department-wise', AccountantController.getDepartmentWiseExpenses);
router.get('/expenses/project-wise', AccountantController.getProjectWiseExpenses);
router.get('/expenses/cost-centre-wise', AccountantController.getCostCentreWiseExpenses);

// Bulk CSV Export
router.get('/export/csv', AccountantController.bulkCsvExport);

export default router;


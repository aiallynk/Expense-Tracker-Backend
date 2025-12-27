import { Router } from 'express';

import { AccountantController } from '../controllers/accountant.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { UserRole } from '../utils/enums';

const router = Router();

// All routes require authentication and ACCOUNTANT role
router.use(authMiddleware);
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

export default router;


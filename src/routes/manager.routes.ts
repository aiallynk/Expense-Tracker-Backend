import { Router } from 'express';

import { ManagerController } from '../controllers/manager.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { UserRole } from '../utils/enums';

import teamsRoutes from './teams.routes';

const router = Router();

// All routes require authentication and MANAGER role
router.use(authMiddleware);
router.use(requireRole(UserRole.MANAGER));

// Teams routes
router.use('/teams', teamsRoutes);

// Team management
router.get('/team/members', ManagerController.getTeamMembers);

// Reports
router.get('/team/reports', ManagerController.getTeamReports);
router.get('/team/reports/:id', ManagerController.getReportForReview);
router.post('/team/reports/:id/approve', ManagerController.approveReport);
router.post('/team/reports/:id/reject', ManagerController.rejectReport);

// Expenses
router.get('/team/expenses', ManagerController.getTeamExpenses);
router.post('/team/expenses/:id/approve', ManagerController.approveExpense);
router.post('/team/expenses/:id/reject', ManagerController.rejectExpense);
router.post('/team/expenses/:id/request-changes', ManagerController.requestExpenseChanges);

// Dashboard
router.get('/dashboard', ManagerController.getDashboard);

export default router;


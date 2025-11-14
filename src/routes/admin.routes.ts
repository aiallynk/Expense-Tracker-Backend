import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/role.middleware';

const router = Router();

// All routes require authentication and admin role
router.use(authMiddleware);
router.use(requireAdmin);

// Reports
router.get('/reports', AdminController.getAllReports);
router.post('/reports/:id/approve', AdminController.approveReport);
router.post('/reports/:id/reject', AdminController.rejectReport);
router.get('/reports/:id/export', AdminController.exportReport);

// Expenses
router.get('/expenses', AdminController.getAllExpenses);
router.post('/expenses/:id/approve', AdminController.approveExpense);
router.post('/expenses/:id/reject', AdminController.rejectExpense);

// Dashboard
router.get('/summary/dashboard', AdminController.getDashboard);

export default router;


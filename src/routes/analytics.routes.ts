import { Router } from 'express';

import { AnalyticsController } from '../controllers/analytics.controller';
import { analyticsAuthMiddleware } from '../middleware/analyticsAuth.middleware';

const router = Router();

/**
 * Analytics Routes for Microsoft Fabric / Power BI
 * 
 * All routes:
 * - Require x-api-key header (ANALYTICS_API_KEY from env)
 * - Are read-only (GET only, enforced in middleware)
 * - Require companyId query parameter for data scoping
 * - Do NOT require JWT authentication
 */

// Apply analytics auth middleware to all routes
router.use(analyticsAuthMiddleware);

// Dashboard summary
router.get('/dashboard', AnalyticsController.getDashboard);

// Expense breakdowns
router.get('/expenses/department-wise', AnalyticsController.getDepartmentWiseExpenses);
router.get('/expenses/project-wise', AnalyticsController.getProjectWiseExpenses);
router.get('/expenses/cost-centre-wise', AnalyticsController.getCostCentreWiseExpenses);
router.get('/expenses/category-wise', AnalyticsController.getCategoryWiseExpenses);

// Trends
router.get('/trends/monthly', AnalyticsController.getMonthlyTrends);

// Lists (read-only)
router.get('/reports', AnalyticsController.getReports);
router.get('/expenses', AnalyticsController.getExpenses);

export default router;


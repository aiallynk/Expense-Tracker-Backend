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

// Core endpoints (required by spec)
router.get('/dashboard', AnalyticsController.getDashboard);
router.get('/expenses', AnalyticsController.getExpenses);
router.get('/reports', AnalyticsController.getReports);
router.get('/spend-by-category', AnalyticsController.getSpendByCategory);
router.get('/spend-trend', AnalyticsController.getSpendTrend);
router.get('/approval-funnel', AnalyticsController.getApprovalFunnel);
router.get('/spend-by-user', AnalyticsController.getSpendByUser);
router.get('/spend-by-department', AnalyticsController.getSpendByDepartment);
router.get('/high-value-expenses', AnalyticsController.getHighValueExpenses);

// Additional endpoints (backward compatibility)
router.get('/expenses/department-wise', AnalyticsController.getSpendByDepartment);
router.get('/expenses/project-wise', AnalyticsController.getProjectWiseExpenses);
router.get('/expenses/cost-centre-wise', AnalyticsController.getCostCentreWiseExpenses);
router.get('/expenses/category-wise', AnalyticsController.getSpendByCategory);
router.get('/trends/monthly', AnalyticsController.getSpendTrend);

export default router;


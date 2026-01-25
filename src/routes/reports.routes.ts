import { Router } from 'express';

import { ExpensesController } from '../controllers/expenses.controller';
import { ReportsController } from '../controllers/reports.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createReportSchema,
  updateReportSchema,
  reportActionSchema,
  createExpenseSchema,
} from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.post('/', validate(createReportSchema), ReportsController.create);
router.get('/', ReportsController.getAll);

// Expense routes nested under reports (must come before /:id to avoid route conflicts)
router.post(
  '/:reportId/expenses',
  validate(createExpenseSchema),
  ExpensesController.create
);

// Export routes (must come before /:id to avoid route conflicts)
router.get('/:id/export/excel', ReportsController.exportExcel);
router.get('/:id/export/pdf', ReportsController.exportPDF);

// Voucher selection route (must come before /:id to avoid route conflicts)
router.get('/:id/available-vouchers', ReportsController.getAvailableVouchers);

router.get('/:id', ReportsController.getById);
router.patch('/:id', validate(updateReportSchema), ReportsController.update);
router.delete('/:id', ReportsController.delete);
router.post('/:id/submit', ReportsController.submit);
router.post('/:id/action', validate(reportActionSchema), ReportsController.action);
router.post('/:id/settlement', ReportsController.processSettlement);
router.get('/:id/settlement-info', ReportsController.getSettlementInfo);

export default router;


import { Router } from 'express';

import { ExpensesController } from '../controllers/expenses.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  updateExpenseSchema,
} from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Note: POST /reports/:reportId/expenses is now in reports.routes.ts
router.get('/expenses', ExpensesController.getAll);
router.get('/expenses/:id', ExpensesController.getById);
router.patch(
  '/expenses/:id',
  validate(updateExpenseSchema),
  ExpensesController.update
);
router.delete('/expenses/:id', ExpensesController.delete);

export default router;


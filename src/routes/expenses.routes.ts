import { Router } from 'express';
import { ExpensesController } from '../controllers/expenses.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createExpenseSchema,
  updateExpenseSchema,
} from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.post(
  '/reports/:reportId/expenses',
  validate(createExpenseSchema),
  ExpensesController.create
);
router.get('/expenses', ExpensesController.getAll);
router.get('/expenses/:id', ExpensesController.getById);
router.patch(
  '/expenses/:id',
  validate(updateExpenseSchema),
  ExpensesController.update
);

export default router;


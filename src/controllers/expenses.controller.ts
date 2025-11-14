import { Response } from 'express';
import { ExpensesService } from '../services/expenses.service';
import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import {
  createExpenseSchema,
  updateExpenseSchema,
  expenseFiltersSchema,
} from '../utils/dtoTypes';

export class ExpensesController {
  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createExpenseSchema.parse(req.body);
    const expense = await ExpensesService.createExpense(
      req.params.reportId,
      req.user!.id,
      data
    );

    res.status(201).json({
      success: true,
      data: expense,
    });
  });

  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateExpenseSchema.parse(req.body);
    const expense = await ExpensesService.updateExpense(
      req.params.id,
      req.user!.id,
      data
    );

    res.status(200).json({
      success: true,
      data: expense,
    });
  });

  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const expense = await ExpensesService.getExpenseById(
      req.params.id,
      req.user!.id,
      req.user!.role
    );

    if (!expense) {
      res.status(404).json({
        success: false,
        message: 'Expense not found',
        code: 'EXPENSE_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: expense,
    });
  });

  static getAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    const filters = expenseFiltersSchema.parse(req.query);
    const result = await ExpensesService.listExpensesForUser(req.user!.id, filters);

    res.status(200).json({
      success: true,
      ...result,
    });
  });
}


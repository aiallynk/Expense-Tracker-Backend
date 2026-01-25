import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ExpensesService } from '../services/expenses.service';
import {
  createExpenseSchema,
  updateExpenseSchema,
  expenseFiltersSchema,
} from '../utils/dtoTypes';

export class ExpensesController {
  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createExpenseSchema.parse(req.body);
    const reportId = Array.isArray(req.params.reportId) ? req.params.reportId[0] : req.params.reportId;
    const expense = await ExpensesService.createExpense(
      reportId,
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
    const expenseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const expense = await ExpensesService.updateExpense(
      expenseId,
      req.user!.id,
      data
    );

    res.status(200).json({
      success: true,
      data: expense,
    });
  });

  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const expenseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const expense = await ExpensesService.getExpenseById(
      expenseId,
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
    // Pass req for company-wide filtering (important for duplicate detection)
    const result = await ExpensesService.listExpensesForUser(req.user!.id, filters, req);

    res.status(200).json({
      success: true,
      ...result,
    });
  });

  static delete = asyncHandler(async (req: AuthRequest, res: Response) => {
    const expenseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await ExpensesService.deleteExpense(expenseId, req.user!.id, req.user!.role);

    res.status(200).json({
      success: true,
      message: 'Expense deleted successfully',
    });
  });
}


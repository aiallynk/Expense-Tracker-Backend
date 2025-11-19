import { Response } from 'express';
import { CategoriesService } from '../services/categories.service';
import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import {
  createCategorySchema,
  updateCategorySchema,
} from '../utils/dtoTypes';

export class CategoriesController {
  static getAll = asyncHandler(async (_req: AuthRequest, res: Response) => {
    const categories = await CategoriesService.getAllCategories();

    res.status(200).json({
      success: true,
      data: categories,
    });
  });

  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const category = await CategoriesService.getCategoryById(req.params.id);

    if (!category) {
      res.status(404).json({
        success: false,
        message: 'Category not found',
        code: 'CATEGORY_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: category,
    });
  });

  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createCategorySchema.parse(req.body);
    const category = await CategoriesService.createCategory(data);

    res.status(201).json({
      success: true,
      data: category,
    });
  });

  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateCategorySchema.parse(req.body);
    const category = await CategoriesService.updateCategory(req.params.id, data);

    res.status(200).json({
      success: true,
      data: category,
    });
  });

  static delete = asyncHandler(async (req: AuthRequest, res: Response) => {
    await CategoriesService.deleteCategory(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Category deleted successfully',
    });
  });

  // Get or create category by name (allows users to auto-create categories)
  static getOrCreateByName = asyncHandler(async (req: AuthRequest, res: Response) => {
    const name = req.params.name;
    if (!name || name.trim() === '') {
      res.status(400).json({
        success: false,
        message: 'Category name is required',
        code: 'INVALID_NAME',
      });
      return;
    }

    const category = await CategoriesService.getOrCreateCategoryByName(name.trim());
    res.status(200).json({
      success: true,
      data: category,
    });
  });
}


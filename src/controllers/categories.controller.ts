import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CategoriesService } from '../services/categories.service';
import { User } from '../models/User';
import {
  createCategorySchema,
  updateCategorySchema,
} from '../utils/dtoTypes';

export class CategoriesController {
  static getAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get user's company ID
    const user = await User.findById(req.user?.id).select('companyId').exec();
    const companyId = user?.companyId?.toString();

    const categories = await CategoriesService.getAllCategories(companyId);

    res.status(200).json({
      success: true,
      data: categories,
    });
  });

  static getAdminCategories = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get user's company ID
    const user = await User.findById(req.user?.id).select('companyId').exec();
    const companyId = user?.companyId?.toString();

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const categories = await CategoriesService.getAdminCategories(companyId);

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
    
    // Get user's company ID
    const user = await User.findById(req.user?.id).select('companyId').exec();
    const companyId = user?.companyId?.toString();

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const category = await CategoriesService.createCategory({
      ...data,
      companyId,
      description: req.body.description,
    });

    res.status(201).json({
      success: true,
      data: category,
    });
  });

  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateCategorySchema.parse(req.body);
    const category = await CategoriesService.updateCategory(req.params.id, {
      ...data,
      description: req.body.description,
      status: req.body.status,
    });

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

    // Get user's company ID
    const user = await User.findById(req.user?.id).select('companyId').exec();
    const companyId = user?.companyId?.toString();

    const category = await CategoriesService.getOrCreateCategoryByName(name.trim(), companyId);
    res.status(200).json({
      success: true,
      data: category,
    });
  });

  // Initialize default categories for the company
  static initializeDefaults = asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await User.findById(req.user?.id).select('companyId').exec();
    const companyId = user?.companyId?.toString();

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const result = await CategoriesService.initializeDefaultCategories(companyId);

    res.status(200).json({
      success: true,
      message: `Initialized ${result.created} default categories`,
      data: result,
    });
  });
}

import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { User } from '../models/User';
import { CategoriesService } from '../services/categories.service';
import { CategoryMatchingService } from '../services/categoryMatching.service';
import {
  createCategorySchema,
  updateCategorySchema,
} from '../utils/dtoTypes';

// Helper function to get company ID for both regular users and company admins
async function getCompanyId(req: AuthRequest): Promise<string | undefined> {
  // If user is COMPANY_ADMIN, look in CompanyAdmin collection
  if (req.user?.role === 'COMPANY_ADMIN') {
    const companyAdmin = await CompanyAdmin.findById(req.user.id).select('companyId').exec();
    return companyAdmin?.companyId?.toString();
  }
  
  // Otherwise look in User collection
  const user = await User.findById(req.user?.id).select('companyId').exec();
  return user?.companyId?.toString();
}

export class CategoriesController {
  static getAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

    const categories = await CategoriesService.getAllCategories(companyId);

    res.status(200).json({
      success: true,
      data: categories,
    });
  });

  static getAdminCategories = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

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
    const categoryId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const category = await CategoriesService.getCategoryById(categoryId);

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
    
    const companyId = await getCompanyId(req);

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
      description: data.description || req.body.description,
    });

    res.status(201).json({
      success: true,
      data: category,
    });
  });

  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateCategorySchema.parse(req.body);
    const categoryId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const category = await CategoriesService.updateCategory(categoryId, {
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
    const categoryId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await CategoriesService.deleteCategory(categoryId);

    res.status(200).json({
      success: true,
      message: 'Category deleted successfully',
    });
  });

  // Get or create category by name (allows users to auto-create categories)
  static getOrCreateByName = asyncHandler(async (req: AuthRequest, res: Response) => {
    const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    if (!name || name.trim() === '') {
      res.status(400).json({
        success: false,
        message: 'Category name is required',
        code: 'INVALID_NAME',
      });
      return;
    }

    const companyId = await getCompanyId(req);

    const category = await CategoriesService.getOrCreateCategoryByName(name.trim(), companyId);
    res.status(200).json({
      success: true,
      data: category,
    });
  });

  // Initialize default categories for the company
  static initializeDefaults = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

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

  // AI-powered category matching for OCR receipts
  static matchCategory = asyncHandler(async (req: AuthRequest, res: Response) => {
    const { vendor, lineItems, notes, extractedText } = req.body;

    if (!vendor && !lineItems && !notes && !extractedText) {
      res.status(400).json({
        success: false,
        message: 'At least one of vendor, lineItems, notes, or extractedText is required',
        code: 'MISSING_CONTENT',
      });
      return;
    }

    const companyId = await getCompanyId(req);

    const receiptContent = {
      vendor: vendor?.trim(),
      lineItems: Array.isArray(lineItems) ? lineItems : undefined,
      notes: notes?.trim(),
      extractedText: extractedText?.trim(),
    };

    const result = await CategoryMatchingService.findBestCategoryMatch(
      receiptContent,
      companyId ? new mongoose.Types.ObjectId(companyId) : undefined
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  });
}

import mongoose from 'mongoose';

import { Category, ICategory, CategoryStatus } from '../models/Category';
import { CreateCategoryDto, UpdateCategoryDto } from '../utils/dtoTypes';

import { logger } from '@/config/logger';

export class CategoriesService {
  /**
   * Get all categories for a company (includes system defaults + company custom)
   */
  static async getAllCategories(companyId?: string): Promise<ICategory[]> {
    const query: any = { status: CategoryStatus.ACTIVE };
    
    if (companyId) {
      // Get both company-specific and system (no companyId) categories
      query.$or = [
        { companyId: new mongoose.Types.ObjectId(companyId) },
        { companyId: { $exists: false } },
        { companyId: null },
      ];
    }
    
    return Category.find(query).sort({ isCustom: 1, name: 1 }).exec();
  }

  /**
   * Get all categories for admin management (all statuses)
   */
  static async getAdminCategories(companyId: string): Promise<ICategory[]> {
    const query: any = {
      $or: [
        { companyId: new mongoose.Types.ObjectId(companyId) },
        { companyId: { $exists: false } },
        { companyId: null },
      ],
    };
    
    logger.debug({ companyId, query }, 'Fetching admin categories');
    
    const categories = await Category.find(query)
      .sort({ isCustom: 1, name: 1 })
      .exec();
    
    logger.debug({ count: categories.length, companyId }, 'Admin categories fetched');
    
    return categories;
  }

  static async getCategoryById(id: string): Promise<ICategory | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return Category.findById(id).exec();
  }

  static async createCategory(
    data: CreateCategoryDto & { companyId?: string; description?: string }
  ): Promise<ICategory> {
    logger.debug({ data }, 'Creating category');
    
    // Check if a category with the same name already exists for this company
    // Use case-insensitive matching to prevent duplicates
    const existingCategory = await this.getCategoryByName(data.name.trim(), data.companyId);
    
    if (existingCategory) {
      logger.info({ 
        categoryId: existingCategory._id, 
        companyId: data.companyId, 
        name: data.name 
      }, 'Category already exists, returning existing category');
      return existingCategory;
    }
    
    // If code is provided, check if a category with that code already exists
    // Code has a unique sparse index, so we need to handle this gracefully
    if (data.code?.trim()) {
      const codeUpper = data.code.trim().toUpperCase();
      const existingByCode = await Category.findOne({ 
        code: codeUpper,
        companyId: data.companyId ? new mongoose.Types.ObjectId(data.companyId) : { $exists: false }
      }).exec();
      
      if (existingByCode) {
        logger.warn({ 
          companyId: data.companyId, 
          code: codeUpper,
          existingCategoryId: existingByCode._id
        }, 'Category with this code already exists, but name is different - allowing creation with different code');
        // Continue with creation but use a modified code to avoid conflict
        // Or we could return the existing category - but since name is different, create new one
      }
    }
    
    const category = new Category({
      name: data.name.trim(),
      code: data.code?.trim().toUpperCase() || undefined,
      description: data.description?.trim() || undefined,
      companyId: data.companyId ? new mongoose.Types.ObjectId(data.companyId) : undefined,
      status: CategoryStatus.ACTIVE,
      isCustom: true,
    });
    
    try {
      const saved = await category.save();
      logger.info({ categoryId: saved._id, companyId: data.companyId, name: data.name }, 'Category created successfully');
      return saved;
    } catch (error: any) {
      // Handle duplicate key error (E11000) - may occur if unique index still exists in database
      // If we still get a duplicate error despite checking, try to find and return the existing category
      if (error.code === 11000 || (error.name === 'MongoServerError' && error.message?.includes('duplicate key'))) {
        logger.warn({ 
          companyId: data.companyId, 
          categoryName: data.name,
          categoryCode: data.code,
          error: error.message 
        }, 'Category creation failed - duplicate key error, attempting to find existing category');
        
        // Try to find by name first
        const existingByName = await this.getCategoryByName(data.name.trim(), data.companyId);
        if (existingByName) {
          logger.info({ 
            categoryId: existingByName._id, 
            companyId: data.companyId, 
            name: data.name 
          }, 'Found existing category by name after duplicate key error');
          return existingByName;
        }
        
        // If code was provided and caused the conflict, try to find by code
        if (data.code?.trim()) {
          const existingByCode = await Category.findOne({ 
            code: data.code.trim().toUpperCase(),
            companyId: data.companyId ? new mongoose.Types.ObjectId(data.companyId) : { $exists: false }
          }).exec();
          
          if (existingByCode) {
            logger.info({ 
              categoryId: existingByCode._id, 
              companyId: data.companyId, 
              code: data.code 
            }, 'Found existing category by code after duplicate key error');
            return existingByCode;
          }
        }
        
        // If we can't find it, create without code if code was the issue
        if (data.code?.trim() && error.message?.includes('code')) {
          logger.info({ 
            companyId: data.companyId, 
            name: data.name,
            code: data.code 
          }, 'Retrying category creation without code due to code conflict');
          
          const categoryWithoutCode = new Category({
            name: data.name.trim(),
            code: undefined, // Don't set code if it conflicts
            description: data.description?.trim() || undefined,
            companyId: data.companyId ? new mongoose.Types.ObjectId(data.companyId) : undefined,
            status: CategoryStatus.ACTIVE,
            isCustom: true,
          });
          
          try {
            const saved = await categoryWithoutCode.save();
            logger.info({ categoryId: saved._id, companyId: data.companyId, name: data.name }, 'Category created successfully without code');
            return saved;
          } catch (retryError: any) {
            // If still fails, throw original error
            logger.error({ error: retryError, originalError: error }, 'Failed to create category even without code');
          }
        }
        
        // If we can't resolve it, re-throw with a clearer message
        const duplicateError: any = new Error(
          'A category with this name or code already exists. Please use a different name or code.'
        );
        duplicateError.statusCode = 400;
        duplicateError.code = 'DUPLICATE_CATEGORY';
        throw duplicateError;
      }
      // Re-throw other errors
      throw error;
    }
  }

  static async updateCategory(
    id: string,
    data: UpdateCategoryDto & { description?: string; status?: string }
  ): Promise<ICategory> {
    const category = await Category.findById(id);

    if (!category) {
      throw new Error('Category not found');
    }

    if (data.name !== undefined) {
      category.name = data.name;
    }

    if (data.code !== undefined) {
      category.code = data.code;
    }

    if (data.description !== undefined) {
      category.description = data.description;
    }

    if (data.status !== undefined) {
      category.status = data.status as CategoryStatus;
    }

    return category.save();
  }

  static async deleteCategory(id: string): Promise<void> {
    const category = await Category.findById(id);

    if (!category) {
      throw new Error('Category not found');
    }

    // Don't allow deleting system categories
    if (!category.isCustom) {
      throw new Error('Cannot delete system default categories');
    }

    // Check if category is used in any expenses
    const { Expense } = await import('../models/Expense');
    const expenseCount = await Expense.countDocuments({ categoryId: id });
    
    if (expenseCount > 0) {
      throw new Error('Category is already in use and cannot be deleted');
    }

    await Category.findByIdAndDelete(id);
  }

  /**
   * Get category by name (case-insensitive).
   * When companyId is provided, only returns a category that belongs to that company
   * (so duplicate check allows the same name in different companies).
   */
  static async getCategoryByName(name: string, companyId?: string): Promise<ICategory | null> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query: Record<string, unknown> = { name: { $regex: new RegExp(`^${escaped}$`, 'i') } };

    if (companyId) {
      query.companyId = new mongoose.Types.ObjectId(companyId);
    }

    return Category.findOne(query as any).exec();
  }

  // Get or create category by name (useful for ensuring categories exist)
  static async getOrCreateCategoryByName(name: string, companyId?: string): Promise<ICategory> {
    const existing = await this.getCategoryByName(name, companyId);
    if (existing) {
      return existing;
    }
    // Create new category if it doesn't exist
    const category = new Category({ 
      name: name.trim(),
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : undefined,
      isCustom: true,
      status: CategoryStatus.ACTIVE,
    });
    return category.save();
  }

  // Initialize default categories for a company (or system when companyId is undefined)
  static async initializeDefaultCategories(companyId?: string): Promise<{ created: number }> {
    const defaultCategories = [
      { name: 'Travel', code: 'TRV', description: 'Travel and transportation expenses' },
      { name: 'Food', code: 'FOOD', description: 'Meals and food expenses' },
      { name: 'Office', code: 'OFF', description: 'Office supplies and equipment' },
      { name: 'Accommodation', code: 'ACC', description: 'Hotel and lodging expenses' },
      { name: 'Communication', code: 'COM', description: 'Phone, internet, and communication' },
      { name: 'Entertainment', code: 'ENT', description: 'Client entertainment and events' },
      { name: 'Others', code: 'OTH', description: 'Miscellaneous expenses' },
    ];

    let created = 0;

    for (const cat of defaultCategories) {
      try {
        const exists = companyId
          ? await this.getCategoryByName(cat.name, companyId)
          : await Category.findOne({
              name: cat.name,
              $or: [{ companyId: null }, { companyId: { $exists: false } }],
            }).exec();

        if (!exists) {
          await new Category({
            ...cat,
            companyId: companyId ? new mongoose.Types.ObjectId(companyId) : undefined,
            isCustom: false,
            status: CategoryStatus.ACTIVE,
          }).save();
          created++;
        }
      } catch (error) {
        logger.error({ error, category: cat.name }, 'Error creating default category');
      }
    }

    return { created };
  }
}

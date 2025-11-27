import mongoose from 'mongoose';

import { Category, ICategory, CategoryStatus } from '../models/Category';
import { User } from '../models/User';
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
    return Category.find({
      $or: [
        { companyId: new mongoose.Types.ObjectId(companyId) },
        { companyId: { $exists: false } },
        { companyId: null },
      ],
    })
      .sort({ isCustom: 1, name: 1 })
      .exec();
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
    const category = new Category({
      name: data.name,
      code: data.code,
      description: data.description,
      companyId: data.companyId ? new mongoose.Types.ObjectId(data.companyId) : undefined,
      status: CategoryStatus.ACTIVE,
      isCustom: true,
    });
    return category.save();
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

    await Category.findByIdAndDelete(id);
  }

  // Get category by name (case-insensitive)
  static async getCategoryByName(name: string, companyId?: string): Promise<ICategory | null> {
    const query: any = { name: { $regex: new RegExp(`^${name}$`, 'i') } };
    
    if (companyId) {
      query.$or = [
        { companyId: new mongoose.Types.ObjectId(companyId) },
        { companyId: { $exists: false } },
        { companyId: null },
      ];
    }
    
    return Category.findOne(query).exec();
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

  // Initialize default categories for a company
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
        const exists = await Category.findOne({
          name: cat.name,
          $or: [
            { companyId: companyId ? new mongoose.Types.ObjectId(companyId) : null },
            { companyId: { $exists: false } },
          ],
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

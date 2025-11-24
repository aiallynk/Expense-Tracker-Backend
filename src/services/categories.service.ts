import mongoose from 'mongoose';

import { Category, ICategory } from '../models/Category';
import { CreateCategoryDto, UpdateCategoryDto } from '../utils/dtoTypes';

export class CategoriesService {
  static async getAllCategories(): Promise<ICategory[]> {
    return Category.find().sort({ name: 1 }).exec();
  }

  static async getCategoryById(id: string): Promise<ICategory | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return Category.findById(id).exec();
  }

  static async createCategory(data: CreateCategoryDto): Promise<ICategory> {
    const category = new Category(data);
    return category.save();
  }

  static async updateCategory(
    id: string,
    data: UpdateCategoryDto
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

    return category.save();
  }

  static async deleteCategory(id: string): Promise<void> {
    const result = await Category.findByIdAndDelete(id);

    if (!result) {
      throw new Error('Category not found');
    }
  }

  // Get category by name (case-insensitive)
  static async getCategoryByName(name: string): Promise<ICategory | null> {
    return Category.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } }).exec();
  }

  // Get or create category by name (useful for ensuring categories exist)
  static async getOrCreateCategoryByName(name: string): Promise<ICategory> {
    const existing = await this.getCategoryByName(name);
    if (existing) {
      return existing;
    }
    // Create new category if it doesn't exist
    const category = new Category({ name: name.trim() });
    return category.save();
  }

  // Initialize default categories if they don't exist
  static async initializeDefaultCategories(): Promise<void> {
    const defaultCategories = ['Travel', 'Food', 'Office', 'Others'];
    
    for (const categoryName of defaultCategories) {
      const exists = await this.getCategoryByName(categoryName);
      if (!exists) {
        await new Category({ name: categoryName }).save();
      }
    }
  }
}


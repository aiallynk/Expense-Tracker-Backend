import { Category, ICategory } from '../models/Category';
import { CreateCategoryDto, UpdateCategoryDto } from '../utils/dtoTypes';
import mongoose from 'mongoose';

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
}


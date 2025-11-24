import mongoose from 'mongoose';

import { CompanyAdmin } from '../models/CompanyAdmin';
import { Department, IDepartment, DepartmentStatus } from '../models/Department';

import { logger } from '@/config/logger';

export class DepartmentsService {
  // Get all departments for a company
  static async getAllDepartments(companyId: string, filters?: {
    status?: DepartmentStatus;
    isCustom?: boolean;
  }): Promise<IDepartment[]> {
    const query: any = {
      companyId: new mongoose.Types.ObjectId(companyId),
    };

    if (filters?.status) {
      query.status = filters.status;
    }

    if (filters?.isCustom !== undefined) {
      query.isCustom = filters.isCustom;
    }

    return await Department.find(query)
      .populate('headId', 'name email role')
      .sort({ isCustom: 1, name: 1 })
      .exec();
  }

  // Get department by ID
  static async getDepartmentById(departmentId: string, companyId: string): Promise<IDepartment | null> {
    return await Department.findOne({
      _id: new mongoose.Types.ObjectId(departmentId),
      companyId: new mongoose.Types.ObjectId(companyId),
    })
      .populate('headId', 'name email role')
      .exec();
  }

  // Create department
  static async createDepartment(
    companyId: string,
    data: {
      name: string;
      code?: string;
      description?: string;
      status?: DepartmentStatus;
      isCustom?: boolean;
      headId?: string;
    }
  ): Promise<IDepartment> {
    // Check if department with same name already exists in company
    const existing = await Department.findOne({
      companyId: new mongoose.Types.ObjectId(companyId),
      name: data.name.trim(),
    }).exec();

    if (existing) {
      throw new Error('Department with this name already exists in this company');
    }

    // Generate code if not provided
    let code = data.code?.trim().toUpperCase();
    if (!code) {
      code = data.name
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .substring(0, 10);
    }

    const department = new Department({
      name: data.name.trim(),
      code,
      description: data.description?.trim(),
      companyId: new mongoose.Types.ObjectId(companyId),
      status: data.status || DepartmentStatus.ACTIVE,
      isCustom: data.isCustom !== undefined ? data.isCustom : true,
      headId: data.headId ? new mongoose.Types.ObjectId(data.headId) : undefined,
    });

    return await department.save();
  }

  // Update department
  static async updateDepartment(
    departmentId: string,
    companyId: string,
    data: {
      name?: string;
      code?: string;
      description?: string;
      status?: DepartmentStatus;
      headId?: string;
    }
  ): Promise<IDepartment | null> {
    const department = await Department.findOne({
      _id: new mongoose.Types.ObjectId(departmentId),
      companyId: new mongoose.Types.ObjectId(companyId),
    }).exec();

    if (!department) {
      return null;
    }

    if (data.name && data.name.trim() !== department.name) {
      // Check if new name conflicts with existing department
      const existing = await Department.findOne({
        companyId: new mongoose.Types.ObjectId(companyId),
        name: data.name.trim(),
        _id: { $ne: department._id },
      }).exec();

      if (existing) {
        throw new Error('Department with this name already exists in this company');
      }

      department.name = data.name.trim();
    }

    if (data.code !== undefined) {
      department.code = data.code.trim().toUpperCase();
    }

    if (data.description !== undefined) {
      department.description = data.description.trim();
    }

    if (data.status !== undefined) {
      department.status = data.status;
    }

    if (data.headId !== undefined) {
      department.headId = data.headId ? new mongoose.Types.ObjectId(data.headId) : undefined;
    }

    return await department.save();
  }

  // Delete department
  static async deleteDepartment(departmentId: string, companyId: string): Promise<boolean> {
    const result = await Department.deleteOne({
      _id: new mongoose.Types.ObjectId(departmentId),
      companyId: new mongoose.Types.ObjectId(companyId),
      isCustom: true, // Only allow deletion of custom departments
    }).exec();

    return result.deletedCount > 0;
  }

  // Initialize default departments for a company
  static async initializeDefaultDepartments(companyId: string): Promise<IDepartment[]> {
    const defaultDepartments = [
      { name: 'Engineering', code: 'ENG', description: 'Engineering department' },
      { name: 'HR', code: 'HR', description: 'Human Resources department' },
      { name: 'Sales', code: 'SALES', description: 'Sales department' },
      { name: 'Tech/IT', code: 'IT', description: 'Technology/IT department' },
      { name: 'Finance', code: 'FIN', description: 'Finance department' },
      { name: 'Marketing', code: 'MKT', description: 'Marketing department' },
    ];

    const createdDepartments: IDepartment[] = [];

    for (const dept of defaultDepartments) {
      try {
        // Check if department already exists
        const existing = await Department.findOne({
          companyId: new mongoose.Types.ObjectId(companyId),
          name: dept.name,
        }).exec();

        if (!existing) {
          const department = new Department({
            name: dept.name,
            code: dept.code,
            description: dept.description,
            companyId: new mongoose.Types.ObjectId(companyId),
            status: DepartmentStatus.ACTIVE,
            isCustom: false,
          });
          await department.save();
          createdDepartments.push(department);
        } else {
          createdDepartments.push(existing);
        }
      } catch (error) {
        logger.error({ error, departmentName: dept.name }, 'Error creating default department');
      }
    }

    return createdDepartments;
  }

  // Get company ID from company admin ID
  static async getCompanyIdFromAdmin(adminId: string): Promise<string | null> {
    const admin = await CompanyAdmin.findById(adminId).exec();
    return admin?.companyId?.toString() || null;
  }
}


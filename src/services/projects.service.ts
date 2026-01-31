import mongoose from 'mongoose';

import { Project, IProject, ProjectStatus } from '../models/Project';

import { ProjectStakeholderService } from './projectStakeholder.service';

interface CreateProjectInput {
  name: string;
  code: string;
  description?: string;
  companyId: string;
  costCentreId?: string;
  managerId?: string;
  startDate?: string;
  endDate?: string;
  budget?: number;
  status?: string;
  isGlobal?: boolean;
}

interface UpdateProjectInput {
  name?: string;
  code?: string;
  description?: string;
  costCentreId?: string | null;
  managerId?: string;
  startDate?: string;
  endDate?: string;
  budget?: number;
  status?: string;
  isGlobal?: boolean;
}

export class ProjectsService {
  /**
   * Get all active projects for a company
   */
  static async getAllProjects(companyId: string): Promise<IProject[]> {
    return Project.find({
      companyId: new mongoose.Types.ObjectId(companyId),
      status: { $ne: ProjectStatus.INACTIVE },
    })
      .populate('managerId', 'name email')
      .populate('costCentreId', 'name code')
      .sort({ name: 1 })
      .exec();
  }

  /**
   * Get all projects for admin management (all statuses)
   */
  static async getAdminProjects(companyId: string): Promise<IProject[]> {
    return Project.find({
      companyId: new mongoose.Types.ObjectId(companyId),
    })
      .populate('managerId', 'name email')
      .populate('costCentreId', 'name code')
      .sort({ status: 1, name: 1 })
      .exec();
  }

  static async getProjectById(id: string): Promise<IProject | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return Project.findById(id)
      .populate('managerId', 'name email')
      .populate('costCentreId', 'name code')
      .exec();
  }

  static async createProject(data: CreateProjectInput): Promise<IProject> {
    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
      throw new Error('Project name is required');
    }
    if (!data.code || typeof data.code !== 'string' || !data.code.trim()) {
      throw new Error('Project code is required');
    }
    if (!data.costCentreId && !data.isGlobal) {
      throw new Error('Cost centre is required for non-global projects');
    }
    const codeValue = data.code.trim().toUpperCase();

    const startDateVal =
      data.startDate != null && String(data.startDate).trim() !== ''
        ? new Date(data.startDate)
        : undefined;
    const endDateVal =
      data.endDate != null && String(data.endDate).trim() !== ''
        ? new Date(data.endDate)
        : undefined;
    const validStartDate =
      startDateVal != null && !Number.isNaN(startDateVal.getTime()) ? startDateVal : undefined;
    const validEndDate =
      endDateVal != null && !Number.isNaN(endDateVal.getTime()) ? endDateVal : undefined;

    const budgetNum =
      data.budget != null && typeof data.budget === 'number' && Number.isFinite(data.budget) && data.budget >= 0
        ? data.budget
        : undefined;

    const projectData: Record<string, unknown> = {
      name: data.name.trim(),
      code: codeValue,
      description:
        data.description != null && String(data.description).trim() !== ''
          ? data.description
          : undefined,
      companyId: new mongoose.Types.ObjectId(data.companyId),
      costCentreId: data.costCentreId ? new mongoose.Types.ObjectId(data.costCentreId) : undefined,
      managerId: data.managerId ? new mongoose.Types.ObjectId(data.managerId) : undefined,
      startDate: validStartDate,
      endDate: validEndDate,
      budget: budgetNum,
      status: (data.status as ProjectStatus) || ProjectStatus.ACTIVE,
      isGlobal: data.isGlobal ?? false,
    };
    const project = new Project(projectData);

    const saved = await project.save();

    // Skip populate in test environment to avoid model registration issues
    if (process.env.NODE_ENV === 'test') {
      return saved;
    }

    return Project.findById(saved._id)
      .populate('managerId', 'name email')
      .populate('costCentreId', 'name code')
      .exec() as Promise<IProject>;
  }

  static async updateProject(
    id: string,
    data: UpdateProjectInput
  ): Promise<IProject> {
    const project = await Project.findById(id);

    if (!project) {
      throw new Error('Project not found');
    }

    if (data.name !== undefined) {
      project.name = data.name;
    }

    if (data.code !== undefined) {
      const codeVal =
        typeof data.code === 'string' && data.code.trim()
          ? data.code.trim().toUpperCase()
          : undefined;
      if (!codeVal) {
        throw new Error('Project code is required');
      }
      project.code = codeVal;
    }

    if (data.description !== undefined) {
      project.description = data.description;
    }

    if (data.costCentreId !== undefined) {
      project.costCentreId = data.costCentreId
        ? new mongoose.Types.ObjectId(data.costCentreId)
        : undefined;
    }

    if (data.managerId !== undefined) {
      project.managerId = data.managerId ? new mongoose.Types.ObjectId(data.managerId) : undefined;
    }

    if (data.startDate !== undefined) {
      project.startDate = data.startDate ? new Date(data.startDate) : undefined;
    }

    if (data.endDate !== undefined) {
      project.endDate = data.endDate ? new Date(data.endDate) : undefined;
    }

    if (data.budget !== undefined) {
      project.budget = data.budget;
    }

    if (data.status !== undefined) {
      project.status = data.status as ProjectStatus;
    }

    if (data.isGlobal !== undefined) {
      project.isGlobal = data.isGlobal;
    }

    await project.save();
    
    return Project.findById(id)
      .populate('managerId', 'name email')
      .populate('costCentreId', 'name code')
      .exec() as Promise<IProject>;
  }

  static async deleteProject(id: string): Promise<void> {
    const result = await Project.findByIdAndDelete(id);

    if (!result) {
      throw new Error('Project not found');
    }
  }

  /**
   * Get projects by manager
   */
  static async getProjectsByManager(managerId: string): Promise<IProject[]> {
    return Project.find({
      managerId: new mongoose.Types.ObjectId(managerId),
      status: { $ne: ProjectStatus.INACTIVE },
    })
      .sort({ name: 1 })
      .exec();
  }

  /**
   * Get projects accessible to a user (global + assigned)
   */
  static async getUserProjects(userId: string, companyId: string): Promise<IProject[]> {
    return ProjectStakeholderService.getUserProjects(userId, companyId);
  }
}

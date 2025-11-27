import mongoose from 'mongoose';

import { Project, IProject, ProjectStatus } from '../models/Project';

interface CreateProjectInput {
  name: string;
  code?: string;
  description?: string;
  companyId: string;
  managerId?: string;
  startDate?: string;
  endDate?: string;
  budget?: number;
  status?: string;
}

interface UpdateProjectInput {
  name?: string;
  code?: string;
  description?: string;
  managerId?: string;
  startDate?: string;
  endDate?: string;
  budget?: number;
  status?: string;
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
      .sort({ status: 1, name: 1 })
      .exec();
  }

  static async getProjectById(id: string): Promise<IProject | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return Project.findById(id)
      .populate('managerId', 'name email')
      .exec();
  }

  static async createProject(data: CreateProjectInput): Promise<IProject> {
    const project = new Project({
      name: data.name,
      code: data.code,
      description: data.description,
      companyId: new mongoose.Types.ObjectId(data.companyId),
      managerId: data.managerId ? new mongoose.Types.ObjectId(data.managerId) : undefined,
      startDate: data.startDate ? new Date(data.startDate) : undefined,
      endDate: data.endDate ? new Date(data.endDate) : undefined,
      budget: data.budget,
      status: (data.status as ProjectStatus) || ProjectStatus.ACTIVE,
    });
    
    const saved = await project.save();
    return Project.findById(saved._id)
      .populate('managerId', 'name email')
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
      project.code = data.code;
    }

    if (data.description !== undefined) {
      project.description = data.description;
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

    await project.save();
    
    return Project.findById(id)
      .populate('managerId', 'name email')
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
}

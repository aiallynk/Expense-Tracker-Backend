import { Project, IProject } from '../models/Project';
import { CreateProjectDto, UpdateProjectDto } from '../utils/dtoTypes';
import mongoose from 'mongoose';

export class ProjectsService {
  static async getAllProjects(): Promise<IProject[]> {
    return Project.find().sort({ name: 1 }).exec();
  }

  static async getProjectById(id: string): Promise<IProject | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return Project.findById(id).exec();
  }

  static async createProject(data: CreateProjectDto): Promise<IProject> {
    const project = new Project(data);
    return project.save();
  }

  static async updateProject(
    id: string,
    data: UpdateProjectDto
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

    if (data.metadata !== undefined) {
      project.metadata = data.metadata;
    }

    return project.save();
  }

  static async deleteProject(id: string): Promise<void> {
    const result = await Project.findByIdAndDelete(id);

    if (!result) {
      throw new Error('Project not found');
    }
  }
}


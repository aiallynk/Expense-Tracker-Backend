import { Response } from 'express';
import { ProjectsService } from '../services/projects.service';
import { asyncHandler } from '../middleware/error.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import {
  createProjectSchema,
  updateProjectSchema,
} from '../utils/dtoTypes';

export class ProjectsController {
  static getAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    const projects = await ProjectsService.getAllProjects();

    res.status(200).json({
      success: true,
      data: projects,
    });
  });

  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const project = await ProjectsService.getProjectById(req.params.id);

    if (!project) {
      res.status(404).json({
        success: false,
        message: 'Project not found',
        code: 'PROJECT_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: project,
    });
  });

  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createProjectSchema.parse(req.body);
    const project = await ProjectsService.createProject(data);

    res.status(201).json({
      success: true,
      data: project,
    });
  });

  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateProjectSchema.parse(req.body);
    const project = await ProjectsService.updateProject(req.params.id, data);

    res.status(200).json({
      success: true,
      data: project,
    });
  });

  static delete = asyncHandler(async (req: AuthRequest, res: Response) => {
    await ProjectsService.deleteProject(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Project deleted successfully',
    });
  });
}


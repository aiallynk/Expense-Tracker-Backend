import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ProjectsService } from '../services/projects.service';
import { User } from '../models/User';

export class ProjectsController {
  static getAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get user's company ID
    const user = await User.findById(req.user?.id).select('companyId').exec();
    const companyId = user?.companyId?.toString();

    if (!companyId) {
      res.status(200).json({
        success: true,
        data: [],
      });
      return;
    }

    const projects = await ProjectsService.getAllProjects(companyId);

    res.status(200).json({
      success: true,
      data: projects,
    });
  });

  static getAdminProjects = asyncHandler(async (req: AuthRequest, res: Response) => {
    // Get user's company ID
    const user = await User.findById(req.user?.id).select('companyId').exec();
    const companyId = user?.companyId?.toString();

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const projects = await ProjectsService.getAdminProjects(companyId);

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
    // Get user's company ID
    const user = await User.findById(req.user?.id).select('companyId').exec();
    const companyId = user?.companyId?.toString();

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const project = await ProjectsService.createProject({
      name: req.body.name,
      code: req.body.code,
      description: req.body.description,
      companyId,
      managerId: req.body.managerId,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      budget: req.body.budget,
      status: req.body.status,
    });

    res.status(201).json({
      success: true,
      data: project,
    });
  });

  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const project = await ProjectsService.updateProject(req.params.id, {
      name: req.body.name,
      code: req.body.code,
      description: req.body.description,
      managerId: req.body.managerId,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      budget: req.body.budget,
      status: req.body.status,
    });

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

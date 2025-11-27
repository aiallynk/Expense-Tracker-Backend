import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ProjectsService } from '../services/projects.service';
import { User } from '../models/User';
import { CompanyAdmin } from '../models/CompanyAdmin';

// Helper function to get company ID for both regular users and company admins
async function getCompanyId(req: AuthRequest): Promise<string | undefined> {
  // If user is COMPANY_ADMIN, look in CompanyAdmin collection
  if (req.user?.role === 'COMPANY_ADMIN') {
    const companyAdmin = await CompanyAdmin.findById(req.user.id).select('companyId').exec();
    return companyAdmin?.companyId?.toString();
  }
  
  // Otherwise look in User collection
  const user = await User.findById(req.user?.id).select('companyId').exec();
  return user?.companyId?.toString();
}

export class ProjectsController {
  static getAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

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
    const companyId = await getCompanyId(req);

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
    const companyId = await getCompanyId(req);

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

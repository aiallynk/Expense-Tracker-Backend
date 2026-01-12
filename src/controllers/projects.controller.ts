import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { User } from '../models/User';
import { ProjectsService } from '../services/projects.service';

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

    // If user is company admin, show all projects
    if (req.user?.role === 'COMPANY_ADMIN') {
      const projects = await ProjectsService.getAdminProjects(companyId);
      res.status(200).json({
        success: true,
        data: projects,
      });
      return;
    }

    // Otherwise, show only projects accessible to the user
    const projects = await ProjectsService.getUserProjects(req.user!.id, companyId);

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
    const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const project = await ProjectsService.getProjectById(projectId);

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
      costCentreId: req.body.costCentreId,
      managerId: req.body.managerId,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      budget: req.body.budget,
      status: req.body.status,
      isGlobal: req.body.isGlobal,
    });

    res.status(201).json({
      success: true,
      data: project,
    });
  });

  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const project = await ProjectsService.updateProject(projectId, {
      name: req.body.name,
      code: req.body.code,
      description: req.body.description,
      costCentreId: req.body.costCentreId,
      managerId: req.body.managerId,
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      budget: req.body.budget,
      status: req.body.status,
      isGlobal: req.body.isGlobal,
    });

    res.status(200).json({
      success: true,
      data: project,
    });
  });

  static delete = asyncHandler(async (req: AuthRequest, res: Response) => {
    const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await ProjectsService.deleteProject(projectId);

    res.status(200).json({
      success: true,
      message: 'Project deleted successfully',
    });
  });
}

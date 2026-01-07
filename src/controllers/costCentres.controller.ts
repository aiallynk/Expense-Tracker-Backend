import { Response } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { User } from '../models/User';
import { CostCentresService } from '../services/costCentres.service';
import {
  createCostCentreSchema,
  updateCostCentreSchema,
} from '../utils/dtoTypes';

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

export class CostCentresController {
  static getAll = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

    const costCentres = await CostCentresService.getAllCostCentres(companyId);

    res.status(200).json({
      success: true,
      data: costCentres,
    });
  });

  static getAdminCostCentres = asyncHandler(async (req: AuthRequest, res: Response) => {
    const companyId = await getCompanyId(req);

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const costCentres = await CostCentresService.getAdminCostCentres(companyId);

    res.status(200).json({
      success: true,
      data: costCentres,
    });
  });

  static getById = asyncHandler(async (req: AuthRequest, res: Response) => {
    const costCentre = await CostCentresService.getCostCentreById(req.params.id);

    if (!costCentre) {
      res.status(404).json({
        success: false,
        message: 'Cost centre not found',
        code: 'COST_CENTRE_NOT_FOUND',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: costCentre,
    });
  });

  static create = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = createCostCentreSchema.parse(req.body);
    
    const companyId = await getCompanyId(req);

    if (!companyId) {
      res.status(400).json({
        success: false,
        message: 'User is not associated with a company',
        code: 'NO_COMPANY',
      });
      return;
    }

    const costCentre = await CostCentresService.createCostCentre({
      ...data,
      companyId,
      description: data.description || req.body.description,
    });

    res.status(201).json({
      success: true,
      data: costCentre,
    });
  });

  static update = asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateCostCentreSchema.parse(req.body);
    const costCentre = await CostCentresService.updateCostCentre(req.params.id, {
      ...data,
      description: req.body.description,
      status: req.body.status,
    });

    res.status(200).json({
      success: true,
      data: costCentre,
    });
  });

  static delete = asyncHandler(async (req: AuthRequest, res: Response) => {
    await CostCentresService.deleteCostCentre(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Cost centre deleted successfully',
    });
  });

  // Get or create cost centre by name (allows users to auto-create cost centres)
  static getOrCreateByName = asyncHandler(async (req: AuthRequest, res: Response) => {
    const name = req.params.name;
    if (!name || name.trim() === '') {
      res.status(400).json({
        success: false,
        message: 'Cost centre name is required',
        code: 'INVALID_NAME',
      });
      return;
    }

    const companyId = await getCompanyId(req);

    const costCentre = await CostCentresService.getOrCreateCostCentreByName(name.trim(), companyId);
    res.status(200).json({
      success: true,
      data: costCentre,
    });
  });
}


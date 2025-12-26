import mongoose from 'mongoose';

import { CostCentre, ICostCentre, CostCentreStatus } from '../models/CostCentre';
import { CreateCostCentreDto, UpdateCostCentreDto } from '../utils/dtoTypes';

import { logger } from '@/config/logger';

export class CostCentresService {
  /**
   * Get all cost centres for a company (active only)
   */
  static async getAllCostCentres(companyId?: string): Promise<ICostCentre[]> {
    const query: any = { status: CostCentreStatus.ACTIVE };
    
    if (companyId) {
      // Get both company-specific and system (no companyId) cost centres
      query.$or = [
        { companyId: new mongoose.Types.ObjectId(companyId) },
        { companyId: { $exists: false } },
        { companyId: null },
      ];
    }
    
    return CostCentre.find(query).sort({ name: 1 }).exec();
  }

  /**
   * Get all cost centres for admin management (all statuses)
   */
  static async getAdminCostCentres(companyId: string): Promise<ICostCentre[]> {
    const query: any = {
      $or: [
        { companyId: new mongoose.Types.ObjectId(companyId) },
        { companyId: { $exists: false } },
        { companyId: null },
      ],
    };
    
    logger.debug({ companyId, query }, 'Fetching admin cost centres');
    
    const costCentres = await CostCentre.find(query)
      .sort({ name: 1 })
      .exec();
    
    logger.debug({ count: costCentres.length, companyId }, 'Admin cost centres fetched');
    
    return costCentres;
  }

  static async getCostCentreById(id: string): Promise<ICostCentre | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return CostCentre.findById(id).exec();
  }

  static async createCostCentre(
    data: CreateCostCentreDto & { companyId?: string }
  ): Promise<ICostCentre> {
    logger.debug({ data }, 'Creating cost centre');
    
    const costCentre = new CostCentre({
      name: data.name,
      code: data.code,
      description: data.description,
      budget: data.budget,
      companyId: data.companyId ? new mongoose.Types.ObjectId(data.companyId) : undefined,
      status: CostCentreStatus.ACTIVE,
    });
    
    const saved = await costCentre.save();
    logger.info({ costCentreId: saved._id, companyId: data.companyId, name: data.name }, 'Cost centre created successfully');
    
    return saved;
  }

  static async updateCostCentre(
    id: string,
    data: UpdateCostCentreDto & { status?: string }
  ): Promise<ICostCentre> {
    const costCentre = await CostCentre.findById(id);

    if (!costCentre) {
      throw new Error('Cost centre not found');
    }

    if (data.name !== undefined) {
      costCentre.name = data.name;
    }

    if (data.code !== undefined) {
      costCentre.code = data.code;
    }

    if (data.description !== undefined) {
      costCentre.description = data.description;
    }

    if (data.budget !== undefined) {
      costCentre.budget = data.budget;
    }

    if (data.status !== undefined) {
      costCentre.status = data.status as CostCentreStatus;
    }

    return costCentre.save();
  }

  static async deleteCostCentre(id: string): Promise<void> {
    const costCentre = await CostCentre.findById(id);

    if (!costCentre) {
      throw new Error('Cost centre not found');
    }

    // Soft delete: set status to INACTIVE instead of hard delete
    costCentre.status = CostCentreStatus.INACTIVE;
    await costCentre.save();
  }

  // Get cost centre by name (case-insensitive)
  static async getCostCentreByName(name: string, companyId?: string): Promise<ICostCentre | null> {
    const query: any = { name: { $regex: new RegExp(`^${name}$`, 'i') } };
    
    if (companyId) {
      query.$or = [
        { companyId: new mongoose.Types.ObjectId(companyId) },
        { companyId: { $exists: false } },
        { companyId: null },
      ];
    }
    
    return CostCentre.findOne(query).exec();
  }

  // Get or create cost centre by name (useful for ensuring cost centres exist)
  static async getOrCreateCostCentreByName(name: string, companyId?: string): Promise<ICostCentre> {
    const existing = await this.getCostCentreByName(name, companyId);
    if (existing) {
      return existing;
    }
    // Create new cost centre if it doesn't exist
    const costCentre = new CostCentre({ 
      name: name.trim(),
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : undefined,
      status: CostCentreStatus.ACTIVE,
    });
    return costCentre.save();
  }
}


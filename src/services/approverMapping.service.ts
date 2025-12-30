import mongoose from 'mongoose';

import { ApproverMapping, IApproverMapping } from '../models/ApproverMapping';
import { User } from '../models/User';

/**
 * Approver Mapping Service
 * Manages user-to-approver mappings for L1-L5 approval levels
 */
export class ApproverMappingService {
  /**
   * Get approver mapping for a user
   */
  static async getMappingByUserId(
    userId: string,
    companyId: string
  ): Promise<IApproverMapping | null> {
    return await ApproverMapping.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      companyId: new mongoose.Types.ObjectId(companyId),
      isActive: true,
    })
      .populate('level1ApproverId', 'name email role')
      .populate('level2ApproverId', 'name email role')
      .populate('level3ApproverId', 'name email role')
      .populate('level4ApproverId', 'name email role')
      .populate('level5ApproverId', 'name email role')
      .exec();
  }

  /**
   * Get all mappings for a company
   */
  static async getMappingsByCompanyId(
    companyId: string
  ): Promise<IApproverMapping[]> {
    return await ApproverMapping.find({
      companyId: new mongoose.Types.ObjectId(companyId),
      isActive: true,
    })
      .populate('userId', 'name email role employeeId')
      .populate('level1ApproverId', 'name email role')
      .populate('level2ApproverId', 'name email role')
      .populate('level3ApproverId', 'name email role')
      .populate('level4ApproverId', 'name email role')
      .populate('level5ApproverId', 'name email role')
      .exec();
  }

  /**
   * Create or update approver mapping
   */
  static async upsertMapping(
    userId: string,
    companyId: string,
    mapping: {
      level1ApproverId?: string;
      level2ApproverId?: string;
      level3ApproverId?: string;
      level4ApproverId?: string;
      level5ApproverId?: string;
    },
    updatedBy: string
  ): Promise<IApproverMapping> {
    // Validate that all approver IDs are valid users in the same company
    const approverIds = [
      mapping.level1ApproverId,
      mapping.level2ApproverId,
      mapping.level3ApproverId,
      mapping.level4ApproverId,
      mapping.level5ApproverId,
    ].filter(Boolean) as string[];

    if (approverIds.length > 0) {
      const approvers = await User.find({
        _id: { $in: approverIds.map(id => new mongoose.Types.ObjectId(id)) },
        companyId: new mongoose.Types.ObjectId(companyId),
        status: 'ACTIVE',
      }).exec();

      if (approvers.length !== approverIds.length) {
        throw new Error('One or more approver IDs are invalid or not in the same company');
      }
    }

    // Deactivate existing mapping
    await ApproverMapping.updateMany(
      {
        userId: new mongoose.Types.ObjectId(userId),
        companyId: new mongoose.Types.ObjectId(companyId),
        isActive: true,
      },
      { isActive: false }
    ).exec();

    // Create new mapping
    const newMapping = new ApproverMapping({
      userId: new mongoose.Types.ObjectId(userId),
      companyId: new mongoose.Types.ObjectId(companyId),
      level1ApproverId: mapping.level1ApproverId
        ? new mongoose.Types.ObjectId(mapping.level1ApproverId)
        : undefined,
      level2ApproverId: mapping.level2ApproverId
        ? new mongoose.Types.ObjectId(mapping.level2ApproverId)
        : undefined,
      level3ApproverId: mapping.level3ApproverId
        ? new mongoose.Types.ObjectId(mapping.level3ApproverId)
        : undefined,
      level4ApproverId: mapping.level4ApproverId
        ? new mongoose.Types.ObjectId(mapping.level4ApproverId)
        : undefined,
      level5ApproverId: mapping.level5ApproverId
        ? new mongoose.Types.ObjectId(mapping.level5ApproverId)
        : undefined,
      isActive: true,
      createdBy: new mongoose.Types.ObjectId(updatedBy),
      updatedBy: new mongoose.Types.ObjectId(updatedBy),
    });

    return await newMapping.save();
  }

  /**
   * Delete (deactivate) approver mapping
   */
  static async deleteMapping(
    userId: string,
    companyId: string
  ): Promise<void> {
    await ApproverMapping.updateMany(
      {
        userId: new mongoose.Types.ObjectId(userId),
        companyId: new mongoose.Types.ObjectId(companyId),
        isActive: true,
      },
      { isActive: false }
    ).exec();
  }
}


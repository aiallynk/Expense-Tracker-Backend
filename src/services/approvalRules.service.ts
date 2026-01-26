import mongoose from 'mongoose';

import { ApprovalRule, ApprovalRuleTriggerType, ApprovalRuleApproverRole } from '../models/ApprovalRule';

import { logger } from '@/config/logger';

export class ApprovalRulesService {
  /**
   * Get all approval rules for a company
   */
  static async getApprovalRules(companyId: string): Promise<any[]> {
    try {
      const rules = await ApprovalRule.find({ companyId })
        .populate('approverRoleId', 'name description type')
        .sort({ createdAt: -1 })
        .exec();
      return rules;
    } catch (error) {
      logger.error({ error, companyId }, 'Error getting approval rules');
      throw error;
    }
  }

  /**
   * Create a new approval rule
   */
  static async createApprovalRule(
    companyId: string,
    data: {
      triggerType: ApprovalRuleTriggerType;
      thresholdValue: number;
      approverRole?: ApprovalRuleApproverRole; // Optional - can use approverRoleId instead
      approverRoleId?: string; // Optional - custom role ID
      description?: string;
      active?: boolean;
    }
  ): Promise<any> {
    try {
      const ruleData: any = {
        companyId: new mongoose.Types.ObjectId(companyId),
        triggerType: data.triggerType,
        thresholdValue: data.thresholdValue,
        description: data.description,
        active: data.active !== undefined ? data.active : true,
      };

      // Set either approverRole or approverRoleId (not both)
      if (data.approverRoleId) {
        ruleData.approverRoleId = new mongoose.Types.ObjectId(data.approverRoleId);
      } else if (data.approverRole) {
        ruleData.approverRole = data.approverRole;
      } else {
        throw new Error('Either approverRole or approverRoleId must be provided');
      }

      const rule = new ApprovalRule(ruleData);
      const saved = await rule.save();
      
      // Populate role if approverRoleId is used
      if (saved.approverRoleId) {
        await saved.populate('approverRoleId');
      }
      
      return saved;
    } catch (error) {
      logger.error({ error, companyId, data }, 'Error creating approval rule');
      throw error;
    }
  }

  /**
   * Update an approval rule
   */
  static async updateApprovalRule(
    ruleId: string,
    companyId: string,
    data: {
      triggerType?: ApprovalRuleTriggerType;
      thresholdValue?: number;
      approverRole?: ApprovalRuleApproverRole;
      approverRoleId?: string; // New: custom role ID
      description?: string;
      active?: boolean;
    }
  ): Promise<any> {
    try {
      const rule = await ApprovalRule.findOne({
        _id: ruleId,
        companyId: new mongoose.Types.ObjectId(companyId),
      }).exec();

      if (!rule) {
        throw new Error('Approval rule not found');
      }

      if (data.triggerType !== undefined) rule.triggerType = data.triggerType;
      if (data.thresholdValue !== undefined) rule.thresholdValue = data.thresholdValue;
      if (data.description !== undefined) rule.description = data.description;
      if (data.active !== undefined) rule.active = data.active;

      // Handle approver role - can update to either system role or custom role
      if (data.approverRoleId !== undefined) {
        // Setting custom role - clear system role
        rule.approverRoleId = new mongoose.Types.ObjectId(data.approverRoleId);
        rule.approverRole = undefined;
      } else if (data.approverRole !== undefined) {
        // Setting system role - clear custom role
        rule.approverRole = data.approverRole;
        rule.approverRoleId = undefined;
      }

      const saved = await rule.save();
      
      // Populate role if approverRoleId is used
      if (saved.approverRoleId) {
        await saved.populate('approverRoleId');
      }
      
      return saved;
    } catch (error) {
      logger.error({ error, ruleId, companyId, data }, 'Error updating approval rule');
      throw error;
    }
  }

  /**
   * Delete an approval rule
   */
  static async deleteApprovalRule(ruleId: string, companyId: string): Promise<void> {
    try {
      const result = await ApprovalRule.deleteOne({
        _id: ruleId,
        companyId: new mongoose.Types.ObjectId(companyId),
      }).exec();

      if (result.deletedCount === 0) {
        throw new Error('Approval rule not found');
      }
    } catch (error) {
      logger.error({ error, ruleId, companyId }, 'Error deleting approval rule');
      throw error;
    }
  }
}


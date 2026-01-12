import { Response, NextFunction } from 'express';

import { AuthRequest } from '../middleware/auth.middleware';
import { TeamsService } from '../services/teams.service';

export class TeamsController {
  /**
   * Create a new team
   * POST /api/v1/manager/teams
   */
  static async createTeam(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const managerId = req.user!.id; // Use id, not _id
      
      // Fetch manager record to get companyId
      const { User } = await import('../models/User');
      const managerUser = await User.findById(managerId).select('companyId').exec();
      
      if (!managerUser) {
        res.status(404).json({
          success: false,
          message: 'Manager not found',
          code: 'MANAGER_NOT_FOUND',
        });
        return;
      }

      const companyId = managerUser.companyId?.toString();

      if (!companyId) {
        res.status(400).json({
          success: false,
          message: 'Manager must belong to a company',
          code: 'NO_COMPANY',
        });
        return;
      }

      const { name, projectId, memberIds } = req.body;

      if (!name || !name.trim()) {
        res.status(400).json({
          success: false,
          message: 'Team name is required',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const team = await TeamsService.createTeam(companyId, managerId, {
        name,
        projectId,
        memberIds: Array.isArray(memberIds) ? memberIds : [],
      });

      res.status(201).json({
        success: true,
        message: 'Team created successfully',
        data: team,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get all teams for manager
   * GET /api/v1/manager/teams
   */
  static async getTeams(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const managerId = req.user!.id; // Use id, not _id
      const teams = await TeamsService.getTeamsByManager(managerId);

      res.json({
        success: true,
        data: teams,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get team by ID
   * GET /api/v1/manager/teams/:id
   */
  static async getTeam(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const managerId = req.user!.id; // Use id, not _id
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const team = await TeamsService.getTeamById(id, managerId);

      res.json({
        success: true,
        data: team,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Add members to team
   * POST /api/v1/manager/teams/:id/members
   */
  static async addMembers(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const managerId = req.user!.id; // Use id, not _id
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { memberIds } = req.body;

      if (!Array.isArray(memberIds) || memberIds.length === 0) {
        res.status(400).json({
          success: false,
          message: 'memberIds must be a non-empty array',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const team = await TeamsService.addTeamMembers(id, managerId, memberIds);

      res.json({
        success: true,
        message: 'Members added successfully',
        data: team,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Remove member from team
   * DELETE /api/v1/manager/teams/:id/members/:userId
   */
  static async removeMember(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const managerId = req.user!.id; // Use id, not _id
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
      const team = await TeamsService.removeTeamMember(id, managerId, userId);

      res.json({
        success: true,
        message: 'Member removed successfully',
        data: team,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Get team statistics
   * GET /api/v1/manager/teams/stats
   */
  static async getTeamStats(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const managerId = req.user!.id; // Use id, not _id
      const stats = await TeamsService.getTeamStats(managerId);

      res.json({
        success: true,
        data: stats,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * Search employees for adding to team
   * GET /api/v1/manager/teams/search-employees
   */
  static async searchEmployees(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // Fetch manager record to get companyId
      const { User } = await import('../models/User');
      const managerUser = await User.findById(req.user!.id).select('companyId').exec();
      
      if (!managerUser) {
        res.status(404).json({
          success: false,
          message: 'Manager not found',
          code: 'MANAGER_NOT_FOUND',
        });
        return;
      }

      const companyId = managerUser.companyId?.toString();

      if (!companyId) {
        res.status(400).json({
          success: false,
          message: 'Manager must belong to a company to search employees',
          code: 'NO_COMPANY',
        });
        return;
      }

      const { q, excludeMemberIds } = req.query;
      const searchQuery = typeof q === 'string' ? q : '';
      const excludeIds: string[] = Array.isArray(excludeMemberIds)
        ? excludeMemberIds.filter((id): id is string => typeof id === 'string')
        : typeof excludeMemberIds === 'string'
        ? [excludeMemberIds]
        : [];

      const employees = await TeamsService.searchEmployees(companyId, searchQuery, excludeIds);

      res.json({
        success: true,
        data: employees,
      });
    } catch (error: any) {
      next(error);
    }
  }
}


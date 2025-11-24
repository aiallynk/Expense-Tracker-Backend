import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { ExpenseReport } from '../models/ExpenseReport';
import { Project } from '../models/Project';
import { Team, ITeam } from '../models/Team';
import { User } from '../models/User';
import { emitTeamCreated, emitTeamUpdated } from '../socket/realtimeEvents';

import { currencyService } from './currency.service';

import { logger } from '@/config/logger';

export class TeamsService {
  /**
   * Create a new team
   */
  static async createTeam(
    companyId: string,
    managerId: string,
    data: {
      name: string;
      projectId?: string;
      memberIds?: string[];
    }
  ): Promise<ITeam> {
    // Verify manager exists and belongs to company
    const manager = await User.findById(managerId);
    if (!manager) {
      const error: any = new Error('Manager not found');
      error.statusCode = 404;
      error.code = 'MANAGER_NOT_FOUND';
      throw error;
    }

    if (manager.companyId?.toString() !== companyId) {
      const error: any = new Error('Manager does not belong to this company');
      error.statusCode = 403;
      error.code = 'ACCESS_DENIED';
      throw error;
    }

    // Check if team name already exists in company (case-insensitive)
    const existingTeam = await Team.findOne({
      companyId: new mongoose.Types.ObjectId(companyId),
      name: { $regex: new RegExp(`^${data.name.trim()}$`, 'i') }, // Case-insensitive match
      status: 'ACTIVE', // Only check active teams
    });

    if (existingTeam) {
      const error: any = new Error('Team name already exists in this company');
      error.statusCode = 400;
      error.code = 'TEAM_NAME_EXISTS';
      throw error;
    }

    // Verify project if provided
    if (data.projectId) {
      const project = await Project.findById(data.projectId);
      if (!project) {
        const error: any = new Error('Project not found');
        error.statusCode = 404;
        error.code = 'PROJECT_NOT_FOUND';
        throw error;
      }
    }

    // Prepare team members
    const members = [];
    if (data.memberIds && data.memberIds.length > 0) {
      // Verify all members exist and belong to company
      const memberUsers = await User.find({
        _id: { $in: data.memberIds.map(id => new mongoose.Types.ObjectId(id)) },
        companyId: new mongoose.Types.ObjectId(companyId),
      });

      if (memberUsers.length !== data.memberIds.length) {
        const error: any = new Error('Some members not found or do not belong to this company');
        error.statusCode = 400;
        error.code = 'INVALID_MEMBERS';
        throw error;
      }

      members.push(
        ...data.memberIds.map(userId => ({
          userId: new mongoose.Types.ObjectId(userId),
          addedAt: new Date(),
          addedBy: new mongoose.Types.ObjectId(managerId),
        }))
      );
    }

    // Create team
    let team;
    try {
      team = new Team({
        companyId: new mongoose.Types.ObjectId(companyId),
        name: data.name.trim(),
        projectId: data.projectId ? new mongoose.Types.ObjectId(data.projectId) : undefined,
        managerId: new mongoose.Types.ObjectId(managerId),
        members,
        status: 'ACTIVE',
      });

      await team.save();

      // Populate for response
      const populatedTeam = await Team.findById(team._id)
        .populate('projectId', 'name code')
        .populate('managerId', 'name email')
        .populate('members.userId', 'name email phone')
        .exec();

      // Emit real-time event (don't fail if this fails)
      if (populatedTeam) {
        try {
          emitTeamCreated(companyId, populatedTeam.toObject());
        } catch (emitError) {
          logger.error({ error: emitError, teamId: team._id }, 'Error emitting team created event');
          // Don't throw - continue with response
        }
      }

      logger.info({ teamId: team._id, companyId, managerId }, 'Team created');
      return populatedTeam || team;
    } catch (saveError: any) {
      // Handle duplicate key error (unique index violation)
      if (saveError.code === 11000 || saveError.name === 'MongoServerError') {
        logger.warn({ companyId, teamName: data.name.trim() }, 'Team creation failed - duplicate name');
        const error: any = new Error('Team name already exists in this company');
        error.statusCode = 400;
        error.code = 'TEAM_NAME_EXISTS';
        throw error;
      }
      // Re-throw other errors with more details
      logger.error({ 
        error: saveError, 
        companyId, 
        managerId, 
        message: saveError.message,
        stack: saveError.stack,
        name: saveError.name,
        code: saveError.code
      }, 'Error creating team');
      throw saveError;
    }
  }

  /**
   * Add members to a team
   */
  static async addTeamMembers(
    teamId: string,
    managerId: string,
    memberIds: string[]
  ): Promise<ITeam> {
    const team = await Team.findById(teamId).exec();

    if (!team) {
      const error: any = new Error('Team not found');
      error.statusCode = 404;
      error.code = 'TEAM_NOT_FOUND';
      throw error;
    }

    // Verify manager owns the team
    if (team.managerId.toString() !== managerId) {
      const error: any = new Error('You can only add members to your own teams');
      error.statusCode = 403;
      error.code = 'ACCESS_DENIED';
      throw error;
    }

    const companyId = team.companyId.toString();

    // Verify all members exist and belong to company
    const memberUsers = await User.find({
      _id: { $in: memberIds.map(id => new mongoose.Types.ObjectId(id)) },
      companyId: new mongoose.Types.ObjectId(companyId),
    });

    if (memberUsers.length !== memberIds.length) {
      const error: any = new Error('Some members not found or do not belong to this company');
      error.statusCode = 400;
      error.code = 'INVALID_MEMBERS';
      throw error;
    }

    // Add new members (avoid duplicates)
    const existingMemberIds = team.members.map(m => m.userId.toString());
    const newMembers = memberIds
      .filter(id => !existingMemberIds.includes(id))
      .map(userId => ({
        userId: new mongoose.Types.ObjectId(userId),
        addedAt: new Date(),
        addedBy: new mongoose.Types.ObjectId(managerId),
      }));

    team.members.push(...newMembers);
    await team.save();

    // Populate for response
    const populatedTeam = await Team.findById(team._id)
      .populate('projectId', 'name code')
      .populate('managerId', 'name email')
      .populate('members.userId', 'name email phone')
      .exec();

    // Emit real-time event
    if (populatedTeam) {
      emitTeamUpdated(companyId, populatedTeam.toObject());
    }

    logger.info({ teamId, memberIds }, 'Team members added');
    return populatedTeam || team;
  }

  /**
   * Get all teams for a manager
   */
  static async getTeamsByManager(managerId: string): Promise<ITeam[]> {
    const teams = await Team.find({
      managerId: new mongoose.Types.ObjectId(managerId),
      status: 'ACTIVE',
    })
      .populate('projectId', 'name code')
      .populate('members.userId', 'name email phone')
      .sort({ createdAt: -1 })
      .exec();

    return teams;
  }

  /**
   * Get team details by ID
   */
  static async getTeamById(teamId: string, managerId: string): Promise<ITeam> {
    const team = await Team.findOne({
      _id: new mongoose.Types.ObjectId(teamId),
      managerId: new mongoose.Types.ObjectId(managerId),
    })
      .populate('projectId', 'name code')
      .populate('members.userId', 'name email phone')
      .exec();

    if (!team) {
      const error: any = new Error('Team not found');
      error.statusCode = 404;
      error.code = 'TEAM_NOT_FOUND';
      throw error;
    }

    return team;
  }

  /**
   * Get team statistics (expenses by team and category)
   * All amounts are converted to INR in real-time
   */
  static async getTeamStats(managerId: string): Promise<{
    teams: Array<{ teamId: string; teamName: string; totalSpend: number; memberCount: number }>;
    categories: Array<{ categoryName: string; totalSpend: number }>;
  }> {
    try {
      logger.info({ managerId }, 'Getting team stats for manager');
      
      // Get all teams for manager
      const teams = await Team.find({
        managerId: new mongoose.Types.ObjectId(managerId),
        status: 'ACTIVE',
      })
        .populate('members.userId', '_id')
        .exec();
      
      logger.debug({ count: teams?.length || 0 }, 'Teams found');

      if (!teams || teams.length === 0) {
        logger.info({ managerId }, 'No teams found for manager');
        return {
          teams: [],
          categories: [],
        };
      }

      const teamMemberIds = teams.flatMap(team => 
        team.members
          .filter(m => m.userId) // Filter out any null/undefined userIds
          .map(m => {
            // Handle both ObjectId and populated document
            const userId = m.userId;
            if (typeof userId === 'object' && userId !== null) {
              // If it's a populated document, get _id; otherwise use the ObjectId directly
              const idValue = userId._id || userId;
              const idString = idValue ? idValue.toString() : null;
              // Validate it's a valid ObjectId string (24 hex characters)
              if (idString && /^[0-9a-fA-F]{24}$/.test(idString)) {
                return idString;
              }
              logger.warn({ userId, teamId: team._id }, 'Invalid userId found in team member');
              return null;
            }
            const idString = userId ? (userId as any).toString() : null;
            // Validate it's a valid ObjectId string
            if (idString && /^[0-9a-fA-F]{24}$/.test(idString)) {
              return idString;
            }
            logger.warn({ userId, teamId: team._id }, 'Invalid userId found in team member');
            return null;
          })
          .filter(id => id !== null) // Remove any null/invalid IDs
      );

      if (teamMemberIds.length === 0) {
        logger.info({ managerId }, 'No team members found for manager');
        return {
          teams: teams.map(team => ({
            teamId: (team._id as any).toString(),
            teamName: team.name,
            totalSpend: 0,
            memberCount: team.members.length,
          })),
          categories: [],
        };
      }

      // Get all approved reports for team members
      let reports: any[] = [];
      if (teamMemberIds.length > 0) {
        try {
          const objectIds = teamMemberIds
            .filter(id => id && /^[0-9a-fA-F]{24}$/.test(id)) // Double-check validity
            .map(id => new mongoose.Types.ObjectId(id));
          
          if (objectIds.length > 0) {
            reports = await ExpenseReport.find({
              userId: { $in: objectIds },
              status: { $in: ['MANAGER_APPROVED', 'APPROVED'] },
            }).exec();
          }
        } catch (error: any) {
          logger.error({
            error: error.message,
            teamMemberIds,
          }, 'Error querying reports with team member IDs');
          reports = [];
        }
      }

      // Calculate team-wise spending with currency conversion
      const teamStatsPromises = teams.map(async (team) => {
        try {
          const memberIds = team.members
            .filter(m => m.userId)
            .map(m => {
              // Handle both ObjectId and populated document
              const userId = m.userId;
              if (typeof userId === 'object' && userId !== null) {
                const idValue = userId._id || userId;
                const idString = idValue ? idValue.toString() : null;
                // Validate it's a valid ObjectId string
                if (idString && /^[0-9a-fA-F]{24}$/.test(idString)) {
                  return idString;
                }
                return null;
              }
              const idString = userId ? (userId as any).toString() : null;
              // Validate it's a valid ObjectId string
              if (idString && /^[0-9a-fA-F]{24}$/.test(idString)) {
                return idString;
              }
              return null;
            })
            .filter(id => id !== null); // Remove any null/invalid IDs
          
          const teamReports = reports.filter(r => {
            const reportUserId = r.userId;
            let reportUserIdStr: string | null = null;
            
            if (typeof reportUserId === 'object' && reportUserId !== null) {
              const idValue = reportUserId._id || reportUserId;
              reportUserIdStr = idValue ? idValue.toString() : null;
            } else if (reportUserId) {
              reportUserIdStr = reportUserId.toString();
            }
            
            // Validate and check if it's in memberIds
            if (reportUserIdStr && /^[0-9a-fA-F]{24}$/.test(reportUserIdStr)) {
              return memberIds.includes(reportUserIdStr);
            }
            return false;
          });
          
          if (teamReports.length === 0) {
          return {
            teamId: (team._id as any).toString(),
            teamName: team.name,
            totalSpend: 0,
            memberCount: team.members.length,
          };
        }

          // Convert all report amounts to INR
          const convertedAmounts = await Promise.all(
            teamReports.map(async (r) => {
              try {
                const amount = r.totalAmount || 0;
                const currency = r.currency || 'INR';
                return await currencyService.convertToINR(amount, currency);
              } catch (error: any) {
                logger.error({
                  reportId: (r._id as any),
                  amount: r.totalAmount,
                  currency: r.currency,
                  error: error.message,
                }, 'Error converting report amount to INR');
                // Return original amount if conversion fails
                return r.totalAmount || 0;
              }
            })
          );
          
          const totalSpend = convertedAmounts.reduce((sum: number, amount: number) => sum + amount, 0);

          return {
            teamId: (team._id as any).toString(),
            teamName: team.name,
            totalSpend: Math.round(totalSpend * 100) / 100, // Round to 2 decimal places
            memberCount: team.members.length,
          };
        } catch (error: any) {
          logger.error({
            teamId: (team._id as any),
            error: error.message,
          }, 'Error calculating team stats');
          return {
            teamId: (team._id as any).toString(),
            teamName: team.name,
            totalSpend: 0,
            memberCount: team.members.length,
          };
        }
      });

      const teamStats = await Promise.all(teamStatsPromises);

      // Get expenses for category breakdown
      const reportIds = reports.map(r => r._id);
      let expenses: any[] = [];
      
      if (reportIds.length > 0) {
        expenses = await Expense.find({
          reportId: { $in: reportIds },
        })
          .populate('categoryId', 'name')
          .exec();
      }

      // Calculate category-wise spending with currency conversion
      const categoryMap = new Map<string, number>();
      
      if (expenses.length > 0) {
        // Convert all expense amounts to INR
        const expenseConversions = await Promise.all(
          expenses.map(async (exp) => {
            try {
              const amount = exp.amount || 0;
              const currency = exp.currency || 'INR';
              const convertedAmount = await currencyService.convertToINR(amount, currency);
              const categoryName = (exp.categoryId as any)?.name || 'Uncategorized';
              return { categoryName, convertedAmount };
            } catch (error: any) {
              logger.error({
                expenseId: (exp._id as any),
                amount: exp.amount,
                currency: exp.currency,
                error: error.message,
              }, 'Error converting expense amount to INR');
              const categoryName = (exp.categoryId as any)?.name || 'Uncategorized';
              return { categoryName, convertedAmount: exp.amount || 0 };
            }
          })
        );

        expenseConversions.forEach(({ categoryName, convertedAmount }) => {
          categoryMap.set(
            categoryName,
            (categoryMap.get(categoryName) || 0) + convertedAmount
          );
        });
      }

      const categories = Array.from(categoryMap.entries()).map(([name, totalSpend]) => ({
        categoryName: name,
        totalSpend: Math.round(totalSpend * 100) / 100, // Round to 2 decimal places
      }));

      logger.info({
        managerId,
        teamsCount: teamStats.length,
        totalReports: reports.length,
        totalExpenses: expenses.length,
      }, 'Team stats calculated with currency conversion');

      return {
        teams: teamStats,
        categories,
      };
    } catch (error: any) {
      logger.error({
        managerId,
        error: error.message,
        stack: error.stack,
        name: error.name,
      }, 'Error in getTeamStats');
      
      // Re-throw with more context
      const enhancedError: any = new Error(`Failed to get team stats: ${error.message}`);
      enhancedError.statusCode = error.statusCode || 500;
      enhancedError.code = error.code || 'TEAM_STATS_ERROR';
      enhancedError.originalError = error;
      throw enhancedError;
    }
  }

  /**
   * Search employees in company for adding to team
   */
  static async searchEmployees(
    companyId: string,
    searchQuery: string,
    excludeMemberIds: string[] = []
  ): Promise<any[]> {
    if (!companyId) {
      logger.warn('searchEmployees called without companyId');
      return [];
    }

    // Build query - only show EMPLOYEE role users
    // Exclude users who have MANAGER or BUSINESS_HEAD in their roles array
    // Only pure EMPLOYEE role users should be shown (not managers/business heads)
    const query: any = {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: 'ACTIVE',
      role: 'EMPLOYEE', // Primary role must be EMPLOYEE
      // Exclude users who have MANAGER or BUSINESS_HEAD in their roles array
      // Use $and to combine multiple conditions
      $and: [
        {
          $or: [
            { roles: { $exists: false } }, // No roles array field
            { roles: { $size: 0 } }, // Empty roles array
            { roles: { $nin: ['MANAGER', 'BUSINESS_HEAD'] } }, // roles array doesn't contain MANAGER or BUSINESS_HEAD
          ],
        },
      ],
    };

    // Exclude already selected members
    if (excludeMemberIds.length > 0) {
      const excludeObjectIds = excludeMemberIds
        .filter(id => id && mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));
      
      if (excludeObjectIds.length > 0) {
        query._id = { $nin: excludeObjectIds };
      }
    }

    // Add search filter if query provided
    if (searchQuery && searchQuery.trim()) {
      const trimmedQuery = searchQuery.trim();
      const escapedQuery = trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapedQuery, 'i');
      
      // Add search conditions to $and array
      query.$and.push({
        $or: [
          { name: { $regex: regex } },
          { email: { $regex: regex } },
          { 
            employeeId: { 
              $exists: true, 
              $ne: null, 
              $regex: regex 
            } 
          },
        ],
      });
    }

    logger.debug({ 
      companyId, 
      searchQuery, 
      excludeCount: excludeMemberIds.length,
      queryFilter: JSON.stringify(query)
    }, 'Searching employees');

    const employees = await User.find(query)
      .select('name email phone employeeId role departmentId')
      .populate('departmentId', 'name')
      .limit(50)
      .exec();

    logger.debug(`Found ${employees.length} employees matching search criteria`);

    return employees.map(emp => ({
      id: (emp._id as any).toString(),
      _id: (emp._id as any).toString(),
      name: emp.name || '',
      email: emp.email || '',
      phone: emp.phone || '',
      employeeId: emp.employeeId || '',
      role: emp.role,
      department: (emp.departmentId as any)?.name || 'No Department',
    }));
  }

  /**
   * Remove member from team
   */
  static async removeTeamMember(
    teamId: string,
    managerId: string,
    userId: string
  ): Promise<ITeam> {
    const team = await Team.findById(teamId);

    if (!team) {
      const error: any = new Error('Team not found');
      error.statusCode = 404;
      error.code = 'TEAM_NOT_FOUND';
      throw error;
    }

    // Verify manager owns the team
    if (team.managerId.toString() !== managerId) {
      const error: any = new Error('You can only remove members from your own teams');
      error.statusCode = 403;
      error.code = 'ACCESS_DENIED';
      throw error;
    }

    // Remove member
    team.members = team.members.filter(
      m => m.userId.toString() !== userId
    );

    await team.save();

    // Populate for response
    const populatedTeam = await Team.findById(team._id)
      .populate('projectId', 'name code')
      .populate('managerId', 'name email')
      .populate('members.userId', 'name email phone')
      .exec();

    // Emit real-time event
    if (populatedTeam) {
      const companyId = team.companyId.toString();
      emitTeamUpdated(companyId, populatedTeam.toObject());
    }

    logger.info({ teamId, userId }, 'Team member removed');
    return populatedTeam || team;
  }
}


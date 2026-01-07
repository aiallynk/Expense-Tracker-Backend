import mongoose from 'mongoose';

import { Project } from '../models/Project';
import { ProjectStakeholder, IProjectStakeholder } from '../models/ProjectStakeholder';
import { User } from '../models/User';

interface AssignStakeholderInput {
  projectId: string;
  userId: string;
  companyId: string;
  assignedBy: string;
}

interface BulkAssignInput {
  projectId: string;
  userIds: string[];
  companyId: string;
  assignedBy: string;
}


export class ProjectStakeholderService {
  /**
   * Assign a single stakeholder to a project
   */
  static async assignStakeholder(data: AssignStakeholderInput): Promise<IProjectStakeholder> {
    // Validate project exists and belongs to company
    const project = await Project.findOne({
      _id: new mongoose.Types.ObjectId(data.projectId),
      companyId: new mongoose.Types.ObjectId(data.companyId),
    });

    if (!project) {
      throw new Error('Project not found or access denied');
    }

    // Validate user exists and belongs to company
    const user = await User.findOne({
      _id: new mongoose.Types.ObjectId(data.userId),
      companyId: new mongoose.Types.ObjectId(data.companyId),
    });

    if (!user) {
      throw new Error('User not found or access denied');
    }

    // Check if assignment already exists
    const existing = await ProjectStakeholder.findOne({
      projectId: new mongoose.Types.ObjectId(data.projectId),
      userId: new mongoose.Types.ObjectId(data.userId),
    });

    if (existing) {
      if (existing.isActive) {
        throw new Error('User is already assigned to this project');
      } else {
        // Reactivate existing assignment
        existing.isActive = true;
        existing.assignedBy = new mongoose.Types.ObjectId(data.assignedBy);
        existing.assignedAt = new Date();
        return existing.save();
      }
    }

    // Create new assignment
    const stakeholder = new ProjectStakeholder({
      projectId: new mongoose.Types.ObjectId(data.projectId),
      userId: new mongoose.Types.ObjectId(data.userId),
      companyId: new mongoose.Types.ObjectId(data.companyId),
      assignedBy: new mongoose.Types.ObjectId(data.assignedBy),
    });

    return stakeholder.save();
  }

  /**
   * Remove stakeholder from project (soft delete)
   */
  static async removeStakeholder(projectId: string, userId: string, companyId: string): Promise<void> {
    const result = await ProjectStakeholder.findOneAndUpdate(
      {
        projectId: new mongoose.Types.ObjectId(projectId),
        userId: new mongoose.Types.ObjectId(userId),
        companyId: new mongoose.Types.ObjectId(companyId),
      },
      { isActive: false },
      { new: true }
    );

    if (!result) {
      throw new Error('Stakeholder assignment not found');
    }
  }

  /**
   * Get stakeholders for a project
   */
  static async getProjectStakeholders(projectId: string, companyId: string): Promise<any[]> {
    return ProjectStakeholder.find({
      projectId: new mongoose.Types.ObjectId(projectId),
      companyId: new mongoose.Types.ObjectId(companyId),
      isActive: true,
    })
      .populate('userId', 'name email employeeId')
      .sort({ assignedAt: -1 })
      .exec();
  }

  /**
   * Get projects accessible to a user (global projects + assigned projects)
   */
  static async getUserProjects(userId: string, companyId: string): Promise<any[]> {
    // Get global projects
    const globalProjects = await Project.find({
      companyId: new mongoose.Types.ObjectId(companyId),
      isGlobal: true,
      status: { $ne: 'INACTIVE' },
    })
      .populate('managerId', 'name email')
      .populate('costCentreId', 'name code')
      .sort({ name: 1 });

    // Get assigned projects
    const assignedProjectIds = await ProjectStakeholder.find({
      userId: new mongoose.Types.ObjectId(userId),
      companyId: new mongoose.Types.ObjectId(companyId),
      isActive: true,
    }).distinct('projectId');

    const assignedProjects = await Project.find({
      _id: { $in: assignedProjectIds },
      companyId: new mongoose.Types.ObjectId(companyId),
      status: { $ne: 'INACTIVE' },
    })
      .populate('managerId', 'name email')
      .populate('costCentreId', 'name code')
      .sort({ name: 1 });

    // Combine and remove duplicates
    const allProjects = [...globalProjects, ...assignedProjects];
    const uniqueProjects = allProjects.filter(
      (project, index, self) =>
        index === self.findIndex(p => (p._id as any).toString() === (project._id as any).toString())
    );

    return uniqueProjects;
  }

  /**
   * Bulk assign stakeholders via CSV/Excel upload
   */
  static async bulkAssignStakeholders(data: BulkAssignInput): Promise<{
    success: number;
    failed: number;
    errors: string[];
  }> {
    const { projectId, userIds, companyId, assignedBy } = data;
    let success = 0;
    const errors: string[] = [];

    // Validate project
    const project = await Project.findOne({
      _id: new mongoose.Types.ObjectId(projectId),
      companyId: new mongoose.Types.ObjectId(companyId),
    });

    if (!project) {
      throw new Error('Project not found or access denied');
    }

    // Process each user
    for (const userId of userIds) {
      try {
        await this.assignStakeholder({
          projectId,
          userId,
          companyId,
          assignedBy,
        });
        success++;
      } catch (error: any) {
        errors.push(`User ${userId}: ${error.message}`);
      }
    }

    return {
      success,
      failed: userIds.length - success,
      errors,
    };
  }

  /**
   * Validate users for bulk upload
   */
  static async validateUsersForUpload(userIds: string[], companyId: string): Promise<{
    valid: string[];
    invalid: string[];
  }> {
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const userId of userIds) {
      const user = await User.findOne({
        $or: [
          { _id: new mongoose.Types.ObjectId(userId) },
          { employeeId: userId },
          { email: userId },
        ],
        companyId: new mongoose.Types.ObjectId(companyId),
        status: 'ACTIVE',
      });

      if (user) {
        valid.push((user._id as any).toString());
      } else {
        invalid.push(userId);
      }
    }

    return { valid, invalid };
  }
}

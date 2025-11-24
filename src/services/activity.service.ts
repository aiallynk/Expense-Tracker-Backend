import mongoose from 'mongoose';

import { AuditLog } from '../models/AuditLog';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';

export class ActivityService {
  // Get activity logs for a company
  static async getCompanyActivityLogs(
    companyId: string,
    filters?: {
      actionType?: string;
      entityType?: string;
      userId?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      page?: number;
    }
  ): Promise<{ logs: any[]; total: number }> {
    const limit = filters?.limit || 50;
    const page = filters?.page || 1;
    const skip = (page - 1) * limit;

    // Build query
    const query: any = {};

    // Get all user IDs for this company
    const users = await User.find({ companyId: new mongoose.Types.ObjectId(companyId) })
      .select('_id')
      .exec();
    const userIds = users.map(u => u._id);

    if (userIds.length === 0) {
      return { logs: [], total: 0 };
    }

    // Filter by actor (users in company)
    query.actorId = { $in: userIds };

    // Filter by action type
    if (filters?.actionType) {
      query.action = filters.actionType;
    }

    // Filter by entity type
    if (filters?.entityType) {
      query.entityType = filters.entityType;
    }

    // Filter by specific user
    if (filters?.userId) {
      query.actorId = new mongoose.Types.ObjectId(filters.userId);
    }

    // Filter by date range
    if (filters?.from || filters?.to) {
      query.createdAt = {};
      if (filters.from) {
        query.createdAt.$gte = new Date(filters.from);
      }
      if (filters.to) {
        query.createdAt.$lte = new Date(filters.to);
      }
    }

    // Get logs with pagination
    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .populate('actorId', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      AuditLog.countDocuments(query).exec(),
    ]);

    // Format logs for frontend
    const formattedLogs = logs.map(log => {
      const actor = log.actorId as any;
      const action = log.action;
      const entityType = log.entityType;
      const entityId = log.entityId;

      // Generate description based on action and entity type
      let description = '';
      let eventType = '';
      let link = null;

      if (entityType === 'ExpenseReport') {
        if (action === 'CREATE') {
          eventType = 'Report Created';
          description = `Report created`;
          link = `/company-admin/reports/${entityId}`;
        } else if (action === 'STATUS_CHANGE') {
          eventType = 'Report Status Changed';
          description = `Report status changed`;
          link = `/company-admin/reports/${entityId}`;
        } else if (action === 'UPDATE') {
          eventType = 'Report Updated';
          description = `Report updated`;
          link = `/company-admin/reports/${entityId}`;
        }
      } else if (entityType === 'Expense') {
        if (action === 'CREATE') {
          eventType = 'Expense Created';
          description = `Expense created`;
        } else if (action === 'UPDATE') {
          eventType = 'Expense Updated';
          description = `Expense updated`;
        } else if (action === 'STATUS_CHANGE') {
          eventType = 'Expense Status Changed';
          description = `Expense status changed`;
        }
      } else if (entityType === 'User') {
        if (action === 'CREATE') {
          eventType = 'User Created';
          description = `User created: ${actor?.name || 'Unknown'}`;
        } else if (action === 'UPDATE') {
          eventType = 'User Updated';
          description = `User updated: ${actor?.name || 'Unknown'}`;
        } else if (action === 'STATUS_CHANGE') {
          eventType = 'User Status Changed';
          description = `User status changed: ${actor?.name || 'Unknown'}`;
        }
      } else {
        eventType = `${entityType} ${action}`;
        description = `${entityType} ${action}`;
      }

      return {
        id: (log._id as any).toString(),
        timestamp: log.createdAt.toISOString(),
        user: actor?.name || 'System',
        eventType,
        description,
        link,
        action: log.action,
        entityType: log.entityType,
        entityId: entityId.toString(),
        metadata: log.meta || {},
      };
    });

    return { logs: formattedLogs, total };
  }

  // Get recent activity from reports (fallback)
  static async getRecentReportsActivity(
    companyId: string,
    limit: number = 50
  ): Promise<any[]> {
    const users = await User.find({ companyId: new mongoose.Types.ObjectId(companyId) })
      .select('_id')
      .exec();
    const userIds = users.map(u => u._id);

    if (userIds.length === 0) {
      return [];
    }

    const reports = await ExpenseReport.find({
      userId: { $in: userIds },
    })
      .populate('userId', 'name email')
      .sort({ updatedAt: -1 })
      .limit(limit)
      .exec();

    return reports.map(report => {
      const user = report.userId as any;
      return {
        id: (report._id as any).toString(),
        timestamp: report.updatedAt.toISOString(),
        user: user?.name || 'Unknown',
        eventType: `Report ${report.status}`,
        description: `Report "${report.name}" ${report.status.toLowerCase()}`,
        link: `/company-admin/reports/${report._id}`,
        action: 'STATUS_CHANGE',
        entityType: 'ExpenseReport',
        entityId: (report._id as any).toString(),
      };
    });
  }
}


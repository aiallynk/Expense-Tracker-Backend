import mongoose from 'mongoose';

import { AuditLog } from '../models/AuditLog';
import { ExpenseReport } from '../models/ExpenseReport';
import { User } from '../models/User';

export class ActivityService {
  private static readonly ENTITY_LABELS: Record<string, string> = {
    ExpenseReport: 'Report',
    Expense: 'Expense',
    User: 'User',
    CompanyAdmin: 'Company Admin',
    NotificationBroadcast: 'Broadcast',
    Voucher: 'Voucher',
    VoucherUsage: 'Voucher',
    VoucherReturnRequest: 'Voucher Return',
    ServiceAccount: 'Service Account',
  };

  private static readonly ACTION_LABELS: Record<string, string> = {
    CREATE: 'Created',
    UPDATE: 'Updated',
    DELETE: 'Deleted',
    STATUS_CHANGE: 'Changed Status',
    IMPERSONATE: 'Impersonated',
    BACKUP_CREATED: 'Backup Created',
    BACKUP_RESTORED: 'Backup Restored',
    BACKUP_DELETED: 'Backup Deleted',
    SELF_APPROVAL_SKIPPED: 'Self Approval Skipped',
    AUTO_APPROVED: 'Auto Approved',
  };

  private static isObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static toReadableText(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private static getEntityLabel(entityType: string): string {
    return this.ENTITY_LABELS[entityType] || this.toReadableText(entityType || 'Entity');
  }

  private static getActionLabel(action: string): string {
    return this.ACTION_LABELS[action] || this.toReadableText(action || 'ACTION');
  }

  private static toStatusText(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    return this.toReadableText(value);
  }

  private static getLogLink(entityType: string, entityId: string): string | null {
    if (!entityId) return null;
    if (entityType === 'ExpenseReport') return `/company-admin/reports/${entityId}`;
    return null;
  }

  private static buildEventType(
    entityType: string,
    action: string,
    statusText: string | null
  ): string {
    const entityLabel = this.getEntityLabel(entityType);
    const actionLabel = this.getActionLabel(action);
    if (statusText && action === 'STATUS_CHANGE') {
      return `${entityLabel} ${statusText}`;
    }
    return `${entityLabel} ${actionLabel}`;
  }

  private static buildHighlights(
    diff: Record<string, any>,
    meta: Record<string, any>
  ): string[] {
    const highlights: string[] = [];
    const status = this.toStatusText(diff.newStatus || diff.status || meta.newStatus || meta.status);
    const level = diff.level ?? meta.level;
    const comment = typeof diff.comment === 'string' ? diff.comment.trim() : '';
    const action = typeof diff.action === 'string' ? this.toReadableText(diff.action) : '';
    const changedFields = Object.keys(diff).filter((key) => key !== 'comment' && key !== 'status' && key !== 'newStatus');

    if (status) highlights.push(`Status: ${status}`);
    if (typeof level === 'number') highlights.push(`Level: L${level}`);
    if (action) highlights.push(`Action: ${action}`);
    if (changedFields.length > 0) highlights.push(`Fields: ${changedFields.slice(0, 5).join(', ')}`);
    if (comment) highlights.push(`Comment: ${comment.length > 80 ? `${comment.slice(0, 80)}...` : comment}`);

    return highlights;
  }

  private static buildDescription(params: {
    actorName: string;
    action: string;
    entityType: string;
    entityId: string;
    diff: Record<string, any>;
    meta: Record<string, any>;
    statusText: string | null;
  }): string {
    const { actorName, action, entityType, entityId, diff, meta, statusText } = params;
    const entityLabel = this.getEntityLabel(entityType);
    const actionLabel = this.getActionLabel(action).toLowerCase();
    const shortId = entityId ? entityId.slice(-6) : 'unknown';
    const comment = typeof diff.comment === 'string' ? diff.comment.trim() : '';
    const customAction = typeof diff.action === 'string' ? this.toReadableText(diff.action) : '';
    const settlementType = typeof diff.settlementType === 'string' ? this.toReadableText(diff.settlementType) : '';

    let description = `${actorName} ${actionLabel} ${entityLabel.toLowerCase()} (#${shortId})`;

    if (statusText && action === 'STATUS_CHANGE') {
      description += ` to ${statusText}`;
    }

    if (customAction) {
      description += ` (${customAction})`;
    }

    if (settlementType) {
      description += ` [${settlementType}]`;
    }

    if (comment) {
      description += `. Comment: ${comment}`;
    }

    if (!comment && !statusText) {
      const changedFields = Object.keys(diff).filter((key) => key !== 'action');
      if (changedFields.length > 0 && action === 'UPDATE') {
        description += `. Updated fields: ${changedFields.slice(0, 5).join(', ')}`;
      }
    }

    const extraMessage = typeof meta.message === 'string' ? meta.message.trim() : '';
    if (extraMessage) {
      description += `. ${extraMessage}`;
    }

    return description;
  }

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
    const limit = Math.min(Math.max(filters?.limit || 50, 1), 1000);
    const page = Math.max(filters?.page || 1, 1);
    const skip = (page - 1) * limit;

    // Build query
    const query: any = {};

    // Get all user IDs for this company
    const users = await User.find({ companyId: new mongoose.Types.ObjectId(companyId) })
      .select('_id')
      .exec();
    const userIds = users.map((u) => u._id as mongoose.Types.ObjectId);

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
      if (!mongoose.Types.ObjectId.isValid(filters.userId)) {
        return { logs: [], total: 0 };
      }
      const filterUserId = new mongoose.Types.ObjectId(filters.userId);
      const belongsToCompany = userIds.some((id) => id.equals(filterUserId));
      if (!belongsToCompany) {
        return { logs: [], total: 0 };
      }
      query.actorId = filterUserId;
    }

    // Filter by date range
    if (filters?.from || filters?.to) {
      query.createdAt = {};
      if (filters.from) {
        const from = new Date(filters.from);
        if (!isNaN(from.getTime())) {
          query.createdAt.$gte = from;
        }
      }
      if (filters.to) {
        const to = new Date(filters.to);
        if (!isNaN(to.getTime())) {
          query.createdAt.$lte = to;
        }
      }
      if (Object.keys(query.createdAt).length === 0) {
        delete query.createdAt;
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
    const formattedLogs = logs.map((log) => {
      const actor = log.actorId as any;
      const action = log.action;
      const entityType = log.entityType;
      const entityId = log.entityId?.toString?.() || String(log.entityId);
      const diff = this.isObject(log.diff) ? log.diff : {};
      const meta = this.isObject(log.meta) ? log.meta : {};
      const statusText = this.toStatusText(diff.newStatus || diff.status || meta.newStatus || meta.status);
      const actorName = actor?.name || actor?.email || 'System';
      const actionLabel = this.getActionLabel(action);
      const entityLabel = this.getEntityLabel(entityType);
      const eventType = this.buildEventType(entityType, action, statusText);
      const description = this.buildDescription({
        actorName,
        action,
        entityType,
        entityId,
        diff,
        meta,
        statusText,
      });
      const highlights = this.buildHighlights(diff, meta);
      const link = this.getLogLink(entityType, entityId);

      return {
        id: (log._id as any).toString(),
        timestamp: log.createdAt.toISOString(),
        user: actorName,
        actorName,
        actorEmail: actor?.email || '',
        actorRole: actor?.role || '',
        actionLabel,
        entityLabel,
        eventType,
        description,
        link,
        action,
        entityType,
        entityId,
        statusText,
        highlights,
        diff,
        metadata: meta,
        details: {
          diff,
          meta,
        },
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
    const userIds = users.map((u) => u._id as mongoose.Types.ObjectId);

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
        actorName: user?.name || 'Unknown',
        actorEmail: user?.email || '',
        actorRole: '',
        eventType: `Report ${this.toReadableText(report.status)}`,
        description: `Report "${report.name}" ${report.status.toLowerCase()}`,
        link: `/company-admin/reports/${report._id}`,
        action: 'STATUS_CHANGE',
        actionLabel: 'Changed Status',
        entityType: 'ExpenseReport',
        entityLabel: 'Report',
        entityId: (report._id as any).toString(),
        statusText: this.toReadableText(report.status),
        highlights: [],
        diff: {},
        metadata: {},
        details: { diff: {}, meta: {} },
      };
    });
  }
}


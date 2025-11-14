import { AuditLog, IAuditLog } from '../models/AuditLog';
import { AuditAction } from '../utils/enums';

export class AuditService {
  static async log(
    actorId: string,
    entityType: string,
    entityId: string,
    action: AuditAction,
    diff?: Record<string, any>
  ): Promise<IAuditLog> {
    const auditLog = new AuditLog({
      actorId,
      entityType,
      entityId,
      action,
      diff,
    });

    return auditLog.save();
  }

  static async getLogsForEntity(
    entityType: string,
    entityId: string,
    limit: number = 50
  ): Promise<IAuditLog[]> {
    return AuditLog.find({ entityType, entityId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('actorId', 'name email')
      .exec();
  }

  static async getLogsForActor(
    actorId: string,
    limit: number = 50
  ): Promise<IAuditLog[]> {
    return AuditLog.find({ actorId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }
}


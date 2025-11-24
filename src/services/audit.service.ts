import { AuditLog, IAuditLog } from '../models/AuditLog';
import { AuditAction } from '../utils/enums';

import { logger } from '@/config/logger';

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

    const savedLog = await auditLog.save();

    // Emit real-time activity log update
    try {
      // Populate actor info for the log entry
      const populatedLog = await AuditLog.findById(savedLog._id)
        .populate('actorId', 'email name')
        .lean();

      if (populatedLog) {
        const actor = populatedLog.actorId as any;
        
        // Format timestamp to IST
        const date = new Date(savedLog.createdAt);
        const istOffset = 5.5 * 60 * 60 * 1000;
        const utcTime = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
        const istTime = new Date(utcTime + istOffset);
        const year = istTime.getFullYear();
        const month = String(istTime.getMonth() + 1).padStart(2, '0');
        const day = String(istTime.getDate()).padStart(2, '0');
        const hours = String(istTime.getHours()).padStart(2, '0');
        const minutes = String(istTime.getMinutes()).padStart(2, '0');
        const seconds = String(istTime.getSeconds()).padStart(2, '0');
        const istTimestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

        const { emitLogEntry } = await import('../socket/realtimeEvents');
        emitLogEntry({
          type: 'activity',
          id: (savedLog._id as any).toString(),
          timestamp: istTimestamp,
          user: actor?.email || 'system',
          company: actor?.name || 'System',
          eventType: savedLog.action,
          description: `${savedLog.action} on ${savedLog.entityType}`,
          details: savedLog.diff || {},
        });
      }
    } catch (error) {
      // Don't fail if real-time emission fails
      logger.error({ error }, 'Failed to emit real-time log entry');
    }

    return savedLog;
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


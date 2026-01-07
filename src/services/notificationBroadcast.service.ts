import os from 'os';

import mongoose from 'mongoose';

import { CompanyAdmin } from '../models/CompanyAdmin';
import { Notification, NotificationType } from '../models/Notification';
import {
  INotificationBroadcast,
  NotificationBroadcast,
  NotificationBroadcastChannel,
  NotificationBroadcastStatus,
  NotificationBroadcastType,
} from '../models/NotificationBroadcast';
import { User } from '../models/User';
import { AuditAction, BroadcastTargetType, UserRole } from '../utils/enums';
import { getAllUsersTopic, getCompanyTopic } from '../utils/topicUtils';

import { AuditService } from './audit.service';
import { NotificationService } from './notification.service';

import { logger } from '@/config/logger';

export type CreateNotificationBroadcastDto = {
  title: string;
  message: string;
  type: NotificationBroadcastType;
  targetType: BroadcastTargetType; // ALL_USERS | COMPANY
  companyId?: string;
  channels: NotificationBroadcastChannel[];
  scheduledAt?: Date | null;
};

const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

function nowIsoOwner(): string {
  return `${os.hostname()}:${process.pid}`;
}

async function promisePool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number
): Promise<void> {
  const q = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }).map(async () => {
    while (q.length) {
      const item = q.shift();
      if (!item) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

export class NotificationBroadcastService {
  static async createBroadcast(actorId: string, dto: CreateNotificationBroadcastDto): Promise<INotificationBroadcast> {
    // Hard security check (defense in depth)
    const actor = await User.findById(actorId).select('role').exec();
    if (!actor || actor.role !== UserRole.SUPER_ADMIN) {
      throw new Error('Only SUPER_ADMIN can send broadcasts');
    }

    if (dto.targetType === BroadcastTargetType.COMPANY && !dto.companyId) {
      throw new Error('companyId is required when targetType is COMPANY');
    }
    if (!dto.channels || dto.channels.length === 0) {
      throw new Error('At least one channel is required');
    }

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
    const shouldSchedule = !!scheduledAt && scheduledAt.getTime() > Date.now();

    const broadcast = await NotificationBroadcast.create({
      title: dto.title,
      message: dto.message,
      type: dto.type,
      targetType: dto.targetType,
      companyId: dto.companyId ? new mongoose.Types.ObjectId(dto.companyId) : undefined,
      channels: dto.channels,
      scheduledAt: scheduledAt || undefined,
      status: shouldSchedule ? NotificationBroadcastStatus.SCHEDULED : NotificationBroadcastStatus.SENDING,
      createdBy: new mongoose.Types.ObjectId(actorId),
    });

    await AuditService.log(actorId, 'NotificationBroadcast', (broadcast._id as any).toString(), AuditAction.CREATE, {
      title: dto.title,
      type: dto.type,
      targetType: dto.targetType,
      companyId: dto.companyId,
      channels: dto.channels,
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
    });

    // Immediate delivery
    if (!shouldSchedule) {
      // Fire-and-forget would be risky for response semantics; we await for determinism.
      await this.deliverBroadcast((broadcast._id as any).toString(), actorId);
    }

    return (await NotificationBroadcast.findById(broadcast._id).exec()) as any;
  }

  static async listBroadcasts(filters: {
    page?: number;
    limit?: number;
    status?: NotificationBroadcastStatus;
    targetType?: BroadcastTargetType;
    companyId?: string;
  }): Promise<{ broadcasts: INotificationBroadcast[]; total: number }> {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(100, Math.max(1, filters.limit || 20));
    const skip = (page - 1) * limit;

    const query: any = {};
    if (filters.status) query.status = filters.status;
    if (filters.targetType) query.targetType = filters.targetType;
    if (filters.companyId) query.companyId = new mongoose.Types.ObjectId(filters.companyId);

    const [broadcasts, total] = await Promise.all([
      NotificationBroadcast.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      NotificationBroadcast.countDocuments(query).exec(),
    ]);

    return { broadcasts: broadcasts as any, total };
  }

  /**
   * Process scheduled broadcasts that are due.
   * Safe for multi-instance: uses a lightweight lock on the broadcast row.
   */
  static async processDueScheduled(): Promise<void> {
    const owner = nowIsoOwner();
    const now = new Date();
    const staleBefore = new Date(Date.now() - LOCK_STALE_MS);

    // Claim at most a few per tick to avoid long-running loop
    for (let i = 0; i < 10; i++) {
      const claimed = await NotificationBroadcast.findOneAndUpdate(
        {
          status: NotificationBroadcastStatus.SCHEDULED,
          scheduledAt: { $lte: now },
          $or: [{ lockedAt: { $exists: false } }, { lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
        },
        {
          $set: { lockedAt: now, lockOwner: owner, status: NotificationBroadcastStatus.SENDING },
        },
        { new: true }
      ).exec();

      if (!claimed) return;

      try {
        await this.deliverBroadcast((claimed._id as any).toString(), (claimed.createdBy as any).toString());
      } catch (err: any) {
        logger.error({ err, broadcastId: claimed._id }, 'Scheduled broadcast delivery failed');
        // deliverBroadcast already marks FAILED
      }
    }
  }

  static async deliverBroadcast(broadcastId: string, actorIdForAudit?: string): Promise<void> {
    const broadcast = await NotificationBroadcast.findById(broadcastId).exec();
    if (!broadcast) throw new Error('Broadcast not found');

    // Avoid double-send
    if (broadcast.status === NotificationBroadcastStatus.SENT) return;

    const dto = broadcast.toObject() as any;
    const channels = new Set(dto.channels || []);

    const delivery: any = dto.delivery || {};
    const errors: string[] = [];

    // Resolve recipients for EMAIL + IN_APP
    const recipients = await this.resolveRecipients(dto.targetType, dto.companyId?.toString?.());

    // IN_APP: create per-user notification rows
    if (channels.has(NotificationBroadcastChannel.IN_APP)) {
      try {
        const created = await this.createInAppNotifications(recipients, {
          title: dto.title,
          message: dto.message,
          broadcastId: dto._id.toString(),
          broadcastType: dto.type,
          targetType: dto.targetType,
          companyId: dto.companyId?.toString?.(),
          createdBy: dto.createdBy?.toString?.(),
        });
        delivery.inApp = { created };
      } catch (err: any) {
        errors.push(`IN_APP failed: ${err.message || err}`);
      }
    }

    // EMAIL: send to each recipient (best-effort)
    if (channels.has(NotificationBroadcastChannel.EMAIL)) {
      let attempted = 0;
      let sent = 0;
      let failed = 0;

      const emailRecipients = recipients
        .filter((r) => !!r.email)
        .map((r) => ({ email: r.email as string, name: r.name }));

      attempted = emailRecipients.length;

      try {
        await promisePool(
          emailRecipients,
          async (r) => {
            try {
              await NotificationService.sendEmail({
                to: r.email,
                subject: dto.title,
                template: 'broadcast',
                data: {
                  title: dto.title,
                  message: dto.message,
                  type: dto.type,
                  recipientName: r.name || r.email,
                },
              });
              sent += 1;
            } catch (e) {
              failed += 1;
            }
          },
          10
        );
      } catch (err: any) {
        errors.push(`EMAIL failed: ${err.message || err}`);
      }

      delivery.email = { attempted, sent, failed };
    }

    // PUSH: use FCM topics (scalable)
    if (channels.has(NotificationBroadcastChannel.PUSH)) {
      try {
        const topic =
          dto.targetType === BroadcastTargetType.ALL_USERS
            ? getAllUsersTopic()
            : getCompanyTopic(dto.companyId?.toString?.());
        const messageId = await NotificationService.sendBroadcastToTopic(
          {
            title: dto.title,
            body: dto.message,
            data: {
              type: 'BROADCAST',
              broadcastType: dto.type,
              targetType: dto.targetType,
              broadcastId: dto._id.toString(),
              companyId: dto.companyId?.toString?.() || '',
            },
          },
          topic
        );
        delivery.push = { topic, messageId };
      } catch (err: any) {
        errors.push(`PUSH failed: ${err.message || err}`);
      }
    }

    const isSuccess = errors.length === 0;
    const nextStatus = isSuccess ? NotificationBroadcastStatus.SENT : NotificationBroadcastStatus.FAILED;

    await NotificationBroadcast.findByIdAndUpdate(broadcastId, {
      $set: {
        status: nextStatus,
        sentAt: isSuccess ? new Date() : undefined,
        delivery,
        lastError: errors.length ? errors.join(' | ') : undefined,
        lockedAt: undefined,
        lockOwner: undefined,
      },
    }).exec();

    if (actorIdForAudit) {
      await AuditService.log(actorIdForAudit, 'NotificationBroadcast', broadcastId, AuditAction.STATUS_CHANGE, {
        status: nextStatus,
        delivery,
        lastError: errors.length ? errors : undefined,
      });
    }

    if (!isSuccess) {
      throw new Error(errors.join(' | '));
    }
  }

  private static async resolveRecipients(
    targetType: BroadcastTargetType,
    companyId?: string
  ): Promise<Array<{ userId: string; email?: string; name?: string; companyId?: string }>> {
    const userQuery: any = { status: 'ACTIVE', role: { $ne: UserRole.SUPER_ADMIN } };
    const adminQuery: any = { status: 'active' };

    if (targetType === BroadcastTargetType.COMPANY) {
      if (!companyId) throw new Error('companyId required for COMPANY target');
      const cid = new mongoose.Types.ObjectId(companyId);
      userQuery.companyId = cid;
      adminQuery.companyId = cid;
    }

    const [users, companyAdmins] = await Promise.all([
      User.find(userQuery).select('_id email name companyId').lean().exec(),
      CompanyAdmin.find(adminQuery).select('_id email name companyId').lean().exec(),
    ]);

    return [
      ...users.map((u: any) => ({
        userId: u._id.toString(),
        email: u.email,
        name: u.name,
        companyId: u.companyId?.toString?.(),
      })),
      ...companyAdmins.map((a: any) => ({
        userId: a._id.toString(),
        email: a.email,
        name: a.name,
        companyId: a.companyId?.toString?.(),
      })),
    ];
  }

  private static async createInAppNotifications(
    recipients: Array<{ userId: string; companyId?: string }>,
    payload: {
      title: string;
      message: string;
      broadcastId: string;
      broadcastType: string;
      targetType: string;
      companyId?: string;
      createdBy?: string;
    }
  ): Promise<number> {
    if (recipients.length === 0) return 0;

    const docs = recipients.map((r) => ({
      userId: new mongoose.Types.ObjectId(r.userId),
      companyId: r.companyId ? new mongoose.Types.ObjectId(r.companyId) : undefined,
      type: NotificationType.BROADCAST,
      title: payload.title,
      description: payload.message,
      link: '/notifications',
      read: false,
      isBroadcast: true,
      targetType: payload.targetType,
      createdBy: payload.createdBy ? new mongoose.Types.ObjectId(payload.createdBy) : undefined,
      metadata: {
        broadcastId: payload.broadcastId,
        broadcastType: payload.broadcastType,
      },
    }));

    const BATCH_SIZE = 1000;
    let created = 0;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);
      const res = await Notification.insertMany(batch, { ordered: false });
      created += res.length;
    }
    return created;
  }
}



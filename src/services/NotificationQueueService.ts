import { logger } from '@/config/logger';

/**
 * NotificationQueueService
 * 
 * Handles asynchronous notification delivery with retry and backoff.
 * Notifications are sent AFTER approval records are persisted.
 * 
 * This ensures that:
 * 1. Approval records are the source of truth
 * 2. Notification failures do not block approval creation
 * 3. Notifications are retried on failure
 * 4. All notification attempts are logged
 */

interface NotificationTask {
    id: string;
    type: 'APPROVAL_REQUIRED' | 'STATUS_CHANGE' | 'ADDITIONAL_APPROVER';
    payload: any;
    retryCount: number;
    maxRetries: number;
    createdAt: Date;
    lastAttempt?: Date;
}

export class NotificationQueueService {
    private static queue: NotificationTask[] = [];
    private static processing = false;
    private static readonly MAX_RETRIES = 3;
    private static readonly RETRY_DELAYS = [1000, 5000, 15000]; // 1s, 5s, 15s

    /**
     * Enqueue a notification task for processing
     * 
     * @param type - Type of notification
     * @param payload - Notification payload
     * @returns Task ID
     */
    static async enqueue(
        type: NotificationTask['type'],
        payload: any
    ): Promise<string> {
        const taskId = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const task: NotificationTask = {
            id: taskId,
            type,
            payload,
            retryCount: 0,
            maxRetries: this.MAX_RETRIES,
            createdAt: new Date(),
        };

        this.queue.push(task);

        logger.info({
            taskId,
            type,
            queueLength: this.queue.length,
        }, '📬 Notification task enqueued');

        // Start processing if not already running
        if (!this.processing) {
            setImmediate(() => this.processQueue());
        }

        return taskId;
    }

    /**
     * Process the notification queue
     * Processes tasks sequentially with retry on failure
     */
    private static async processQueue(): Promise<void> {
        if (this.processing) {
            return; // Already processing
        }

        this.processing = true;

        while (this.queue.length > 0) {
            const task = this.queue.shift();
            if (!task) continue;

            try {
                await this.processTask(task);
            } catch (error: any) {
                logger.error({
                    error: error.message,
                    taskId: task.id,
                    type: task.type,
                }, '❌ Error processing notification task');

                // Retry logic
                if (task.retryCount < task.maxRetries) {
                    const delay = this.RETRY_DELAYS[task.retryCount] || 15000;
                    task.retryCount++;
                    task.lastAttempt = new Date();

                    logger.warn({
                        taskId: task.id,
                        type: task.type,
                        retryCount: task.retryCount,
                        retryDelay: delay,
                    }, '🔄 Scheduling notification retry');

                    // Re-queue after delay
                    setTimeout(() => {
                        this.queue.push(task);
                        if (!this.processing) {
                            this.processQueue();
                        }
                    }, delay);
                } else {
                    logger.error({
                        taskId: task.id,
                        type: task.type,
                        retryCount: task.retryCount,
                        error: error.message,
                    }, '❌ CRITICAL: Notification failed after max retries - falling back to email');

                    // FALLBACK: Try email notification as last resort
                    await this.fallbackNotification(task);
                }
            }
        }

        this.processing = false;
    }

    /**
     * Process a single notification task
     */
    private static async processTask(task: NotificationTask): Promise<void> {
        logger.info({
            taskId: task.id,
            type: task.type,
            retryCount: task.retryCount,
        }, '📤 Processing notification task');

        switch (task.type) {
            case 'APPROVAL_REQUIRED':
                await this.sendApprovalRequiredNotification(task.payload);
                break;

            case 'STATUS_CHANGE':
                await this.sendStatusChangeNotification(task.payload);
                break;

            case 'ADDITIONAL_APPROVER':
                await this.sendAdditionalApproverNotification(task.payload);
                break;

            default:
                logger.warn({ taskId: task.id, type: task.type }, 'Unknown notification type');
        }

        logger.info({
            taskId: task.id,
            type: task.type,
            retryCount: task.retryCount,
        }, '✅ Notification task completed');
    }

    /**
     * Send approval required notification
     */
    private static async sendApprovalRequiredNotification(payload: {
        approvalInstance: any;
        levelConfig: any;
        requestData: any;
        approverUserIds?: string[];
    }): Promise<void> {
        const { ApprovalMatrixNotificationService } = await import('./approvalMatrixNotification.service');

        await ApprovalMatrixNotificationService.notifyApprovalRequired(
            payload.approvalInstance,
            payload.levelConfig,
            payload.requestData,
            payload.approverUserIds
        );
    }

    /**
     * Send status change notification
     */
    private static async sendStatusChangeNotification(payload: {
        approvalInstance: any;
        requestData: any;
        status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
        comments?: string;
        approvedLevel?: number;
    }): Promise<void> {
        const { ApprovalMatrixNotificationService } = await import('./approvalMatrixNotification.service');

        await ApprovalMatrixNotificationService.notifyRequestStatusChanged(
            payload.approvalInstance,
            payload.requestData,
            payload.status,
            payload.comments,
            payload.approvedLevel
        );
    }

    /**
     * Send additional approver notification
     */
    private static async sendAdditionalApproverNotification(payload: {
        report: any;
        additionalApprovers: Array<{ userId: string; role?: string; triggerReason?: string }>;
    }): Promise<void> {
        const { NotificationService } = await import('./notification.service');

        await NotificationService.notifyAdditionalApproverAdded(
            payload.report,
            payload.additionalApprovers
        );
    }

    /**
     * Fallback notification mechanism
     * When push notifications fail, fall back to email or in-app badge
     */
    private static async fallbackNotification(task: NotificationTask): Promise<void> {
        try {
            logger.warn({
                taskId: task.id,
                type: task.type,
            }, '📧 Attempting fallback email notification');

            // Approval-required emails disabled — only summary and forgot-password emails are sent (per product requirement).
        } catch (error: any) {
            logger.error({
                error: error.message,
                taskId: task.id,
            }, '❌ CRITICAL: Fallback notification also failed');
        }
    }

    /**
     * Get queue status (for monitoring)
     */
    static getQueueStatus(): {
        queueLength: number;
        processing: boolean;
    } {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
        };
    }
}

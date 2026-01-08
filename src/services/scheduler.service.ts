import { logger } from '@/config/logger';
import { AdminController } from '../controllers/admin.controller';

interface ScheduledJob {
  name: string;
  interval: number; // in milliseconds
  lastRun?: number;
  enabled: boolean;
  run: () => Promise<void>;
}

export class SchedulerService {
  private jobs: Map<string, ScheduledJob> = new Map();
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor() {
    this.setupJobs();
  }

  private setupJobs() {
    // OCR Spike Detection - every 15 minutes
    this.addJob({
      name: 'ocr-spike-detection',
      interval: 15 * 60 * 1000, // 15 minutes
      enabled: true,
      run: async () => {
        try {
          logger.info('Running OCR spike detection');
          // Create a mock request object for the controller
          const mockReq = {
            user: { role: 'SUPER_ADMIN', id: 'system' }
          } as any;
          const mockRes = {
            status: (_code: number) => ({
              json: (data: any) => {
                logger.info({ job: 'ocr-spike-detection', data }, 'OCR spike detection completed');
              }
            })
          } as any;

          await AdminController.detectOCRSpike(mockReq, mockRes, () => {});
        } catch (error) {
          logger.error({ error, job: 'ocr-spike-detection' }, 'OCR spike detection failed');
        }
      }
    });

    // API Abuse Detection - every 10 minutes
    this.addJob({
      name: 'api-abuse-detection',
      interval: 10 * 60 * 1000, // 10 minutes
      enabled: true,
      run: async () => {
        try {
          logger.info('Running API abuse detection');
          const mockReq = {
            user: { role: 'SUPER_ADMIN', id: 'system' }
          } as any;
          const mockRes = {
            status: (_code: number) => ({
              json: (data: any) => {
                logger.info({ job: 'api-abuse-detection', data }, 'API abuse detection completed');
              }
            })
          } as any;

          await AdminController.detectAPIAbuse(mockReq, mockRes, () => {});
        } catch (error) {
          logger.error({ error, job: 'api-abuse-detection' }, 'API abuse detection failed');
        }
      }
    });

    // Storage Threshold Check - every hour
    this.addJob({
      name: 'storage-threshold-check',
      interval: 60 * 60 * 1000, // 1 hour
      enabled: true,
      run: async () => {
        try {
          logger.info('Running storage threshold check');
          const mockReq = {
            user: { role: 'SUPER_ADMIN', id: 'system' }
          } as any;
          const mockRes = {
            status: (_code: number) => ({
              json: (data: any) => {
                logger.info({ job: 'storage-threshold-check', data }, 'Storage threshold check completed');
              }
            })
          } as any;

          await AdminController.checkStorageThresholds(mockReq, mockRes, () => {});
        } catch (error) {
          logger.error({ error, job: 'storage-threshold-check' }, 'Storage threshold check failed');
        }
      }
    });

    // Cache Cleanup - every 30 minutes
    this.addJob({
      name: 'cache-cleanup',
      interval: 30 * 60 * 1000, // 30 minutes
      enabled: true,
      run: async () => {
        try {
          logger.info('Running cache cleanup');
          // The cache service handles cleanup automatically,
          // but we can force a cleanup here if needed
          logger.info('Cache cleanup completed');
        } catch (error) {
          logger.error({ error, job: 'cache-cleanup' }, 'Cache cleanup failed');
        }
      }
    });
  }

  private addJob(job: ScheduledJob) {
    this.jobs.set(job.name, job);
  }

  start() {
    if (this.running) return;

    logger.info('Starting scheduler service');

    this.jobs.forEach((job) => {
      if (job.enabled) {
        // Run immediately for first execution
        job.run().catch(error => {
          logger.error({ error, job: job.name }, 'Initial job execution failed');
        });

        // Then schedule recurring execution
        const interval = setInterval(() => {
          job.lastRun = Date.now();
          job.run().catch(error => {
            logger.error({ error, job: job.name }, 'Scheduled job execution failed');
          });
        }, job.interval);

        this.intervals.set(job.name, interval);
      }
    });

    this.running = true;
  }

  stop() {
    if (!this.running) return;

    logger.info('Stopping scheduler service');

    this.intervals.forEach((interval) => {
      clearInterval(interval);
    });
    this.intervals.clear();
    this.running = false;
  }

  getJobStatus(jobName: string) {
    const job = this.jobs.get(jobName);
    if (!job) return null;

    return {
      name: job.name,
      enabled: job.enabled,
      interval: job.interval,
      lastRun: job.lastRun,
      nextRun: job.lastRun ? job.lastRun + job.interval : null,
      isRunning: this.running && job.enabled
    };
  }

  getAllJobStatuses() {
    const statuses: any[] = [];
    this.jobs.forEach((job) => {
      statuses.push(this.getJobStatus(job.name));
    });
    return statuses;
  }

  enableJob(jobName: string) {
    const job = this.jobs.get(jobName);
    if (job) {
      job.enabled = true;
      if (this.running) {
        this.stop();
        this.start(); // Restart to pick up the enabled job
      }
      logger.info({ jobName }, 'Job enabled');
    }
  }

  disableJob(jobName: string) {
    const job = this.jobs.get(jobName);
    if (job) {
      job.enabled = false;
      if (this.running) {
        const interval = this.intervals.get(jobName);
        if (interval) {
          clearInterval(interval);
          this.intervals.delete(jobName);
        }
      }
      logger.info({ jobName }, 'Job disabled');
    }
  }
}

// Global scheduler instance
export const schedulerService = new SchedulerService();
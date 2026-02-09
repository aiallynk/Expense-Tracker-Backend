/**
 * Traffic-aware OCR dispatcher: switches between BLAST (low traffic) and CONTROLLED (high traffic).
 * - BLAST: relaxed per-user and global concurrency for fast parallel OCR.
 * - CONTROLLED: strict global and per-user limits to avoid OpenAI bottlenecks and cost spikes.
 */

import { config } from '../config/index';

export type OcrDispatcherMode = 'BLAST' | 'CONTROLLED';

export interface OcrDispatcherLimits {
  maxGlobalOcr: number;
  maxPerUserOcr: number;
}

const ocrConfig = config.ocr as {
  blast?: { maxGlobalOcr: number; maxPerUserOcr: number };
  controlled?: { maxGlobalOcr: number; maxPerUserOcr: number };
  activeUsersBlastThreshold?: number;
  activeOcrJobsControlledThreshold?: number;
  lowEndMode?: boolean;
};

export class OcrDispatcherService {
  /**
   * Determine mode from current active user count and active OCR job count.
   * CONTROLLED when traffic is high (many users or many jobs); BLAST otherwise.
   */
  static getMode(
    activeUserCount: number,
    activeOcrJobCount: number
  ): OcrDispatcherMode {
    const usersThreshold = ocrConfig.activeUsersBlastThreshold ?? 10;
    const jobsThreshold = ocrConfig.activeOcrJobsControlledThreshold ?? 50;

    if (activeUserCount > usersThreshold || activeOcrJobCount > jobsThreshold) {
      return 'CONTROLLED';
    }
    return 'BLAST';
  }

  /**
   * Return global and per-user concurrency limits for the given mode.
   * When lowEndMode is set, use stricter limits (maxPerUserOcr=1).
   */
  static getLimits(mode: OcrDispatcherMode): OcrDispatcherLimits {
    let limits: OcrDispatcherLimits;
    if (ocrConfig.lowEndMode) {
      limits = {
        maxGlobalOcr: 5,
        maxPerUserOcr: 1,
      };
    } else if (mode === 'BLAST' && ocrConfig.blast) {
      limits = {
        maxGlobalOcr: ocrConfig.blast.maxGlobalOcr,
        maxPerUserOcr: ocrConfig.blast.maxPerUserOcr,
      };
    } else if (ocrConfig.controlled) {
      limits = {
        maxGlobalOcr: ocrConfig.controlled.maxGlobalOcr,
        maxPerUserOcr: ocrConfig.controlled.maxPerUserOcr,
      };
    } else {
      limits = {
        maxGlobalOcr: config.ocr.maxGlobalOcr,
        maxPerUserOcr: config.ocr.maxPerUserOcr,
      };
    }
    return limits;
  }

  /**
   * Get limits for current traffic (convenience: compute mode from counts then return limits).
   */
  static getLimitsForTraffic(
    activeUserCount: number,
    activeOcrJobCount: number
  ): OcrDispatcherLimits {
    const mode = this.getMode(activeUserCount, activeOcrJobCount);
    return this.getLimits(mode);
  }
}

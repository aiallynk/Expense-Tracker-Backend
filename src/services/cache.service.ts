import { logger } from '@/config/logger';

interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number;
}

export class CacheService {
  private cache = new Map<string, CacheEntry>();
  private readonly defaultTTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Get cached data if available and not expired
   */
  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      // Entry expired, remove it
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set data in cache with optional TTL
   */
  set(key: string, data: any, ttl: number = this.defaultTTL): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });

    // Clean up expired entries periodically
    if (Math.random() < 0.01) { // 1% chance on each set
      this.cleanup();
    }
  }

  /**
   * Delete specific cache entry
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { entries: number; totalSize: number } {
    return {
      entries: this.cache.size,
      totalSize: JSON.stringify([...this.cache.entries()]).length
    };
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get or set cache with a fetcher function
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number = this.defaultTTL
  ): Promise<T> {
    const cached = this.get(key);
    if (cached !== null) {
      logger.debug({ key }, 'Cache hit');
      return cached;
    }

    logger.debug({ key }, 'Cache miss, fetching data');
    const data = await fetcher();
    this.set(key, data, ttl);
    return data;
  }
}

// Global cache instance
export const cacheService = new CacheService();

// Cache key generators for analytics
export const cacheKeys = {
  dashboard: (filters?: any) => `dashboard:${JSON.stringify(filters || {})}`,
  companyAnalytics: (companyId: string, filters?: any) =>
    `company-analytics:${companyId}:${JSON.stringify(filters || {})}`,
  miniStats: (companyId: string) => `mini-stats:${companyId}`,
  storageGrowth: (year?: number) => `storage-growth:${year || new Date().getFullYear()}`
};

// Cache invalidation helpers
export const invalidateCompanyCache = (companyId: string) => {
  // Invalidate all cache entries related to this company
  const keysToDelete = [
    cacheKeys.miniStats(companyId),
    // Note: We can't easily invalidate all company analytics variations,
    // so we'll clear all cache when company data changes
  ];

  keysToDelete.forEach(key => cacheService.delete(key));

  // For simplicity, clear all cache when company data changes
  // In production, you might want more sophisticated cache tagging
  logger.info({ companyId }, 'Invalidating company cache');
  cacheService.clear();
};

export const invalidateDashboardCache = () => {
  // Clear all dashboard-related cache
  logger.info('Invalidating dashboard cache');
  cacheService.clear();
};
import fs from 'fs';
import path from 'path';
import { logger } from '@/config/logger';

interface VersionData {
  web: string;
  app: string;
  build: number;
  lastUpdated: string;
}

class VersionService {
  private cachedVersion: VersionData | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 60000; // 1 minute cache
  private readonly versionFilePath: string;

  constructor() {
    // Try to read from BACKEND/version.json first, fallback to root version.json
    const backendVersionPath = path.join(process.cwd(), 'version.json');
    const rootVersionPath = path.join(process.cwd(), '..', 'version.json');
    
    if (fs.existsSync(backendVersionPath)) {
      this.versionFilePath = backendVersionPath;
    } else if (fs.existsSync(rootVersionPath)) {
      this.versionFilePath = rootVersionPath;
    } else {
      // Fallback to default location
      this.versionFilePath = backendVersionPath;
    }
  }

  /**
   * Get version information from version.json file
   * Uses caching to avoid frequent file reads
   */
  getVersion(): VersionData {
    const now = Date.now();
    
    // Return cached version if still valid
    if (this.cachedVersion && (now - this.cacheTimestamp) < this.CACHE_TTL) {
      return this.cachedVersion;
    }

    try {
      // Read version.json file
      const fileContent = fs.readFileSync(this.versionFilePath, 'utf-8');
      const versionData: VersionData = JSON.parse(fileContent);
      
      // Validate version data structure
      if (!versionData.web || !versionData.app || typeof versionData.build !== 'number') {
        throw new Error('Invalid version.json structure');
      }

      // Update cache
      this.cachedVersion = versionData;
      this.cacheTimestamp = now;

      return versionData;
    } catch (error: any) {
      logger.error({ error: error.message, path: this.versionFilePath }, 'Error reading version.json');
      
      // Return fallback version if file read fails
      const fallbackVersion: VersionData = {
        web: '1.0.0',
        app: '1.0.0',
        build: 1,
        lastUpdated: new Date().toISOString().split('T')[0],
      };

      // Cache fallback to avoid repeated file reads on error
      this.cachedVersion = fallbackVersion;
      this.cacheTimestamp = now;

      return fallbackVersion;
    }
  }

  /**
   * Clear cache (useful for testing or forced refresh)
   */
  clearCache(): void {
    this.cachedVersion = null;
    this.cacheTimestamp = 0;
  }
}

export const versionService = new VersionService();

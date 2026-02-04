import fs from 'fs';
import path from 'path';
import { config as appConfig } from '@/config/index';
import { logger } from '@/config/logger';

/**
 * App update configuration from app-update.json
 * Used for in-app APK update prompts (non-Play Store distribution)
 */
export interface AppUpdateConfig {
  latestVersion: string;
  minimumSupportedVersion: string;
  apkUrl: string;
  releaseNotes: string;
  sha256?: string;
}

/**
 * Parses semantic version string (e.g. "1.0.5" or "1.0.6+6") into comparable parts.
 * Strips build suffix (+6) for comparison.
 * Returns [major, minor, patch] or [0, 0, 0] for invalid input.
 */
function parseVersion(version: string): number[] {
  if (!version || typeof version !== 'string') {
    return [0, 0, 0];
  }
  // Strip build suffix (e.g. "1.0.6+6" -> "1.0.6")
  const clean = version.split('+')[0].trim();
  const parts = clean.split('.').map((p) => parseInt(p, 10) || 0);
  // Pad to [major, minor, patch]
  while (parts.length < 3) {
    parts.push(0);
  }
  return parts.slice(0, 3);
}

/**
 * Returns true if versionA < versionB (semantic comparison)
 */
function isVersionLessThan(versionA: string, versionB: string): boolean {
  const a = parseVersion(versionA);
  const b = parseVersion(versionB);
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

class AppUpdateService {
  private cachedConfig: AppUpdateConfig | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 60000; // 1 minute cache
  private readonly configFilePath: string;

  constructor() {
    const backendPath = path.join(process.cwd(), 'app-update.json');
    const rootPath = path.join(process.cwd(), '..', 'app-update.json');
    this.configFilePath = fs.existsSync(backendPath) ? backendPath : rootPath;
  }

  /**
   * Get app update configuration from app-update.json
   * Returns safe fallback (no update required) if file is missing - prevents breaking older deployments
   */
  getConfig(): AppUpdateConfig {
    const now = Date.now();
    if (this.cachedConfig && (now - this.cacheTimestamp) < this.CACHE_TTL) {
      return this.cachedConfig;
    }

    try {
      if (!fs.existsSync(this.configFilePath)) {
        logger.warn({ path: this.configFilePath }, 'app-update.json not found, using fallback (no update required)');
        return this._getFallbackConfig();
      }
      const content = fs.readFileSync(this.configFilePath, 'utf-8');
      const config = JSON.parse(content) as AppUpdateConfig;

      if (!config.latestVersion) {
        logger.warn('Invalid app-update.json: latestVersion required, using fallback');
        return this._getFallbackConfig();
      }

      const apkUrl =
        config.apkUrl && config.apkUrl.length > 0
          ? config.apkUrl
          : `${appConfig.api.baseUrl.replace(/\/$/, '')}/api/app/apk/${config.latestVersion}`;

      this.cachedConfig = {
        latestVersion: config.latestVersion,
        minimumSupportedVersion: config.minimumSupportedVersion ?? config.latestVersion,
        apkUrl,
        releaseNotes: config.releaseNotes ?? '',
        sha256: config.sha256,
      };
      this.cacheTimestamp = now;
      return this.cachedConfig;
    } catch (error: any) {
      logger.error({ error: error.message, path: this.configFilePath }, 'Error reading app-update.json, using fallback');
      return this._getFallbackConfig();
    }
  }

  /** Fallback config when file is missing - no update required for any version */
  private _getFallbackConfig(): AppUpdateConfig {
    const fallback: AppUpdateConfig = {
      latestVersion: '999.0.0',
      minimumSupportedVersion: '0.0.0',
      apkUrl: '',
      releaseNotes: '',
    };
    this.cachedConfig = fallback;
    this.cacheTimestamp = Date.now();
    return fallback;
  }

  /**
   * Get app update info for client.
   * If currentVersion is provided, computes forceUpdate based on minimumSupportedVersion.
   */
  getAppVersionInfo(currentVersion?: string): {
    latestVersion: string;
    minimumSupportedVersion: string;
    forceUpdate: boolean;
    apkUrl: string;
    releaseNotes: string;
    sha256?: string;
  } {
    const config = this.getConfig();
    const forceUpdate =
      currentVersion != null &&
      currentVersion !== '' &&
      isVersionLessThan(currentVersion, config.minimumSupportedVersion);

    return {
      latestVersion: config.latestVersion,
      minimumSupportedVersion: config.minimumSupportedVersion,
      forceUpdate,
      apkUrl: config.apkUrl,
      releaseNotes: config.releaseNotes,
      sha256: config.sha256,
    };
  }

  clearCache(): void {
    this.cachedConfig = null;
    this.cacheTimestamp = 0;
  }
}

export const appUpdateService = new AppUpdateService();

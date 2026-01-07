import { randomUUID } from 'crypto';

import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';

import { s3Client, getS3Bucket } from '../config/aws';
import { Backup, IBackup } from '../models/Backup';
import { emitBackupCreated, emitBackupRestored } from '../socket/realtimeEvents';

import { logger } from '@/config/logger';

export class BackupService {
  /**
   * Create a backup of the database
   */
  static async createBackup(userId?: string): Promise<IBackup> {
    // Create backup record
    const backup = new Backup({
      type: userId ? 'manual' : 'automatic',
      status: 'processing',
      createdBy: userId ? (userId as any) : undefined,
    });

    await backup.save();

    // Emit real-time update
    const istTimestamp = this.formatToIST(new Date());
    emitBackupCreated({
      id: (backup._id as any).toString(),
      timestamp: istTimestamp,
      size: '0 GB',
      type: backup.type,
      status: backup.status,
    });

    // Perform backup asynchronously
    setImmediate(async () => {
      try {
        // Get all collections
        const db = mongoose.connection.db;
        if (!db) {
          throw new Error('Database not connected');
        }

        const collections = await db.listCollections().toArray();
        const backupData: any = {
          version: '1.0',
          timestamp: new Date().toISOString(),
          collections: {},
        };

        let totalSize = 0;
        let totalRecords = 0;

        // Export each collection
        for (const collectionInfo of collections) {
          const collectionName = collectionInfo.name;
          
          // Skip system collections
          if (collectionName.startsWith('system.')) {
            continue;
          }

          const collection = db.collection(collectionName);
          const documents = await collection.find({}).toArray();
          
          if (documents.length > 0) {
            backupData.collections[collectionName] = documents;
            totalRecords += documents.length;
            
            // Estimate size (rough calculation)
            const collectionSize = JSON.stringify(documents).length;
            totalSize += collectionSize;
          }
        }

        // Convert to JSON and compress (in production, use gzip)
        const backupJson = JSON.stringify(backupData);
        const buffer = Buffer.from(backupJson, 'utf-8');
        const actualSize = buffer.length;

        // Upload to S3
        const storageKey = `backups/${(backup._id as any).toString()}/${randomUUID()}.json`;
        const bucket = getS3Bucket('backups');
        
        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: storageKey,
            Body: buffer,
            ContentType: 'application/json',
          })
        );

        // Get S3 URL (presigned URL valid for 7 days)
        const storageUrl = `s3://${bucket}/${storageKey}`;

        // Update backup record
        backup.status = 'completed';
        backup.size = actualSize;
        backup.storageKey = storageKey;
        backup.storageUrl = storageUrl;
        backup.metadata = {
          collections: Object.keys(backupData.collections),
          recordCount: totalRecords,
          version: '1.0',
        };
        backup.completedAt = new Date();
        await backup.save();

        // Emit real-time update
        const completedTimestamp = this.formatToIST(backup.completedAt);
        emitBackupCreated({
          id: (backup._id as any).toString(),
          timestamp: completedTimestamp,
          size: this.formatSize(actualSize),
          type: backup.type,
          status: backup.status,
          metadata: backup.metadata,
        });

        logger.info(`Backup created successfully: ${backup._id}`);
      } catch (error: any) {
        logger.error({ error }, 'Backup creation failed:');
        
        backup.status = 'failed';
        backup.error = error.message || 'Unknown error';
        await backup.save();

        // Emit real-time update
        const errorTimestamp = this.formatToIST(new Date());
        emitBackupCreated({
          id: (backup._id as any).toString(),
          timestamp: errorTimestamp,
          size: '0 GB',
          type: backup.type,
          status: backup.status,
          error: backup.error || 'Unknown error',
        });
      }
    });

    return backup;
  }

  /**
   * Get all backups
   */
  static async getBackups(limit: number = 100): Promise<IBackup[]> {
    return Backup.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('createdBy', 'email name')
      .lean() as unknown as IBackup[];
  }

  /**
   * Get backup by ID
   */
  static async getBackupById(backupId: string): Promise<IBackup | null> {
    return Backup.findById(backupId)
      .populate('createdBy', 'email name')
      .exec();
  }

  /**
   * Restore from backup
   */
  static async restoreBackup(backupId: string, _userId: string): Promise<void> {
    const backup = await Backup.findById(backupId);
    
    if (!backup) {
      throw new Error('Backup not found');
    }

    if (backup.status !== 'completed') {
      throw new Error('Backup is not completed');
    }

    if (!backup.storageKey) {
      throw new Error('Backup storage key not found');
    }

    // Emit restore started event
    emitBackupRestored(backupId);

    // Perform restore asynchronously
    setImmediate(async () => {
      try {
        const db = mongoose.connection.db;
        if (!db) {
          throw new Error('Database not connected');
        }

        // Download backup from S3
        const bucket = getS3Bucket('backups');
        const getObjectResponse = await s3Client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: backup.storageKey!,
          })
        );

        // Convert stream to buffer
        const streamToBuffer = async (stream: any): Promise<Buffer> => {
          const chunks: Buffer[] = [];
          return new Promise((resolve, reject) => {
            (stream as any).on('data', (chunk: Buffer) => chunks.push(chunk));
            (stream as any).on('error', reject);
            (stream as any).on('end', () => resolve(Buffer.concat(chunks)));
          });
        };

        const buffer = await streamToBuffer(getObjectResponse.Body);
        const backupData = JSON.parse(buffer.toString('utf-8'));

        // Clear existing collections (except system collections)
        const existingCollections = await db.listCollections().toArray();
        for (const collectionInfo of existingCollections) {
          const collectionName = collectionInfo.name;
          if (!collectionName.startsWith('system.')) {
            await db.collection(collectionName).deleteMany({});
          }
        }

        // Restore collections
        for (const [collectionName, documents] of Object.entries(backupData.collections || {})) {
          if (Array.isArray(documents) && documents.length > 0) {
            await db.collection(collectionName).insertMany(documents as any[]);
          }
        }

        logger.info(`Backup restored successfully: ${backupId}`);
      } catch (error: any) {
        logger.error({ error }, 'Backup restore failed:');
        throw error;
      }
    });
  }

  /**
   * Download backup file
   */
  static async getBackupDownloadUrl(backupId: string): Promise<string> {
    const backup = await Backup.findById(backupId);
    
    if (!backup || !backup.storageKey) {
      throw new Error('Backup not found or no storage key');
    }

    // In production, generate a presigned URL
    // For now, return the storage URL
    return backup.storageUrl || `s3://${getS3Bucket('backups')}/${backup.storageKey}`;
  }

  /**
   * Format size to human-readable format
   */
  private static formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /**
   * Format date to IST
   */
  private static formatToIST(date: Date): string {
    const istOffset = 5.5 * 60 * 60 * 1000;
    const utcTime = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
    const istTime = new Date(utcTime + istOffset);
    
    const year = istTime.getFullYear();
    const month = String(istTime.getMonth() + 1).padStart(2, '0');
    const day = String(istTime.getDate()).padStart(2, '0');
    const hours = String(istTime.getHours()).padStart(2, '0');
    const minutes = String(istTime.getMinutes()).padStart(2, '0');
    const seconds = String(istTime.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
}


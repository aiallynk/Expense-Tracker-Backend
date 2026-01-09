// randomUUID removed - not used
import { createWriteStream, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { PutObjectCommand, GetObjectCommand, ServerSideEncryption } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';
// archiver needs to be installed: npm install archiver @types/archiver
// Helper function to get archiver (handles CommonJS module exports)
function getArchiver() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const archiverModule = require('archiver');
  // Handle both default export and direct export
  return typeof archiverModule === 'function' 
    ? archiverModule 
    : archiverModule.default || archiverModule;
}

import { s3Client, getS3Bucket } from '../config/aws';
import { Backup, IBackup, BackupType, BackupStatus, IBackupManifest } from '../models/Backup';

// Export for use in controllers
export { BackupType, BackupStatus };
import { Company } from '../models/Company';
import { User } from '../models/User';
import { ExpenseReport } from '../models/ExpenseReport';
import { Expense } from '../models/Expense';
import { OcrJob } from '../models/OcrJob';
import { Receipt } from '../models/Receipt';
import { Department } from '../models/Department';
import { Project } from '../models/Project';
import { CostCentre } from '../models/CostCentre';
import { CompanySettings } from '../models/CompanySettings';
import { emitBackupCreated, emitBackupRestored } from '../socket/realtimeEvents';
import { AuditService } from './audit.service';
import { AuditAction } from '../utils/enums';

import { logger } from '@/config/logger';

/**
 * Enterprise-Grade Backup & Restore Service
 * 
 * Features:
 * - Full system backups (all data)
 * - Company-specific backups (isolated data)
 * - Manifest-based structure
 * - ZIP compression
 * - S3 storage with encryption
 * - Safe restore with ID remapping
 */
export class BackupService {
  private static readonly APP_VERSION = '2.0.0';
  private static readonly BACKUP_VERSION = '2.0';

  /**
   * Create a full system backup
   */
  static async createFullBackup(userId?: string, backupName?: string): Promise<IBackup> {
    return this.createBackup(BackupType.FULL, undefined, userId, backupName);
  }

  /**
   * Create a company-specific backup
   */
  static async createCompanyBackup(
    companyId: string,
    userId?: string,
    backupName?: string
  ): Promise<IBackup> {
    // Validate company exists
    const company = await Company.findById(companyId);
    if (!company) {
      throw new Error('Company not found');
    }

    return this.createBackup(BackupType.COMPANY, companyId, userId, backupName);
  }

  /**
   * Core backup creation logic
   */
  private static async createBackup(
    backupType: BackupType,
    companyId?: string,
    userId?: string,
    backupName?: string
  ): Promise<IBackup> {
    // Create backup record
    const backup = new Backup({
      backupType,
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : undefined,
      backupName,
      status: BackupStatus.PROCESSING,
      createdBy: userId ? new mongoose.Types.ObjectId(userId) : undefined,
    });

    await backup.save();

    // Get creator info for manifest
    let createdByEmail: string | undefined;
    if (userId) {
      const creator = await User.findById(userId).select('email').lean();
      createdByEmail = creator?.email;
    }

    // Get company name for manifest
    let companyName: string | undefined;
    if (companyId) {
      const company = await Company.findById(companyId).select('name').lean();
      companyName = company?.name;
    }

        // Emit real-time update
        const istTimestamp = this.formatToIST(new Date());
        emitBackupCreated({
          id: (backup._id as any).toString(),
          timestamp: istTimestamp,
          size: '0 GB',
          backupType: backupType,
          type: backupType, // Keep for backward compatibility
          status: backup.status,
          companyName,
          backupName: backup.backupName,
        });

    // Perform backup asynchronously
    setImmediate(async () => {
      const tempDir = tmpdir();
      const backupId = (backup._id as any).toString();
      const timestamp = this.getBackupTimestamp();
      const zipFileName = `backup_${timestamp}.zip`;
      const zipFilePath = join(tempDir, zipFileName);

      try {
        // Step 1: Fetch data based on backup type
        const backupData = await this.fetchBackupData(backupType, companyId);

        // Step 2: Create manifest
        const manifest: IBackupManifest = {
          backupId,
          backupType,
          companyId: companyId,
          companyName,
          createdAt: new Date().toISOString(),
          createdBy: userId,
          createdByEmail,
          recordCounts: {
            companies: backupData.companies?.length || 0,
            users: backupData.users?.length || 0,
            reports: backupData.reports?.length || 0,
            expenses: backupData.expenses?.length || 0,
            ocrJobs: backupData.ocrJobs?.length || 0,
            receipts: backupData.receipts?.length || 0,
            departments: backupData.departments?.length || 0,
            projects: backupData.projects?.length || 0,
            costCentres: backupData.costCentres?.length || 0,
          },
          appVersion: this.APP_VERSION,
        };

        // Step 3: Create structured JSON files and ZIP
        await this.createBackupZip(backupData, manifest, zipFilePath);

        // Step 4: Upload to S3
        const storageKey = this.getStorageKey(backupType, companyId, zipFileName);
        const bucket = getS3Bucket('backups');
        const zipBuffer = readFileSync(zipFilePath);
        const actualSize = zipBuffer.length;

        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: storageKey,
            Body: zipBuffer,
            ContentType: 'application/zip',
            ServerSideEncryption: ServerSideEncryption.AES256, // AES-256 encryption
            Metadata: {
              'backup-id': backupId,
              'backup-type': backupType,
              'backup-version': this.BACKUP_VERSION,
              ...(companyId && { 'company-id': companyId }),
            },
          })
        );

        // Step 5: Clean up temp file
        if (existsSync(zipFilePath)) {
          unlinkSync(zipFilePath);
        }

        // Step 6: Update backup record
        backup.status = BackupStatus.COMPLETED;
        backup.size = actualSize;
        backup.storageKey = storageKey;
        backup.storageUrl = `s3://${bucket}/${storageKey}`;
        backup.manifest = manifest;
        backup.metadata = {
          collections: Object.keys(backupData).filter(key => Array.isArray(backupData[key as keyof typeof backupData])),
          recordCount: Object.values(manifest.recordCounts).reduce((sum, count) => sum + (count || 0), 0),
          version: this.BACKUP_VERSION,
        };
        backup.completedAt = new Date();
        await backup.save();

        // Emit real-time update
        const completedTimestamp = this.formatToIST(backup.completedAt);
        emitBackupCreated({
          id: backupId,
          timestamp: completedTimestamp,
          size: this.formatSize(actualSize),
          backupType: backupType,
          type: backupType, // Keep for backward compatibility
          status: backup.status,
          companyName,
          backupName: backup.backupName,
          metadata: backup.metadata,
          manifest: backup.manifest,
        });

        logger.info({ backupId, backupType, companyId, size: actualSize }, 'Backup created successfully');

        // Audit log
        if (userId) {
          await AuditService.log(
            userId,
            'Backup',
            backup._id as any,
            AuditAction.BACKUP_CREATED,
            {
              backupType,
              companyId: companyId || null,
              size: actualSize,
              storageKey,
            }
          );
        }
      } catch (error: any) {
        logger.error({ error, backupId, backupType, companyId }, 'Backup creation failed');

        // Clean up temp file on error
        if (existsSync(zipFilePath)) {
          try {
            unlinkSync(zipFilePath);
          } catch (cleanupError) {
            logger.error({ cleanupError }, 'Failed to cleanup temp backup file');
          }
        }

        backup.status = BackupStatus.FAILED;
        backup.error = error.message || 'Unknown error';
        await backup.save();

        // Emit real-time update
        const errorTimestamp = this.formatToIST(new Date());
        emitBackupCreated({
          id: backupId,
          timestamp: errorTimestamp,
          size: '0 GB',
          backupType: backupType,
          type: backupType, // Keep for backward compatibility
          status: backup.status,
          error: backup.error,
        });
      }
    });

    return backup;
  }

  /**
   * Fetch data based on backup type
   */
  private static async fetchBackupData(backupType: BackupType, companyId?: string) {
    const data: any = {};

    if (backupType === BackupType.FULL) {
      // Full backup: all data
      data.companies = await Company.find({}).lean();
      data.users = await User.find({}).lean();
      data.reports = await ExpenseReport.find({}).lean();
      data.expenses = await Expense.find({}).lean();
      data.ocrJobs = await OcrJob.find({}).lean();
      data.receipts = await Receipt.find({}).lean();
      data.departments = await Department.find({}).lean();
      data.projects = await Project.find({}).lean();
      data.costCentres = await CostCentre.find({}).lean();
      data.companySettings = await CompanySettings.find({}).lean();
    } else {
      // Company backup: only company-specific data
      const companyObjectId = new mongoose.Types.ObjectId(companyId!);

      // Get company
      data.companies = await Company.find({ _id: companyObjectId }).lean();

      // Get company users
      const companyUsers = await User.find({ companyId: companyObjectId }).lean();
      data.users = companyUsers;
      const userIds = companyUsers.map(u => u._id);

      // Get company reports (by userId)
      data.reports = await ExpenseReport.find({ userId: { $in: userIds } }).lean();

      // Get company expenses (by userId)
      data.expenses = await Expense.find({ userId: { $in: userIds } }).lean();

      // Get company receipts (by userId)
      const receiptIds = (await Receipt.find({ userId: { $in: userIds } }).select('_id').lean()).map(r => r._id);
      data.receipts = await Receipt.find({ userId: { $in: userIds } }).lean();

      // Get company OCR jobs (by receiptId)
      data.ocrJobs = await OcrJob.find({ receiptId: { $in: receiptIds } }).lean();

      // Get company departments
      data.departments = await Department.find({ companyId: companyObjectId }).lean();

      // Get company projects
      data.projects = await Project.find({ companyId: companyObjectId }).lean();

      // Get company cost centres
      data.costCentres = await CostCentre.find({ companyId: companyObjectId }).lean();

      // Get company settings
      data.companySettings = await CompanySettings.find({ companyId: companyObjectId }).lean();
    }

    return data;
  }

  /**
   * Create ZIP file with structured JSON files
   */
  private static async createBackupZip(
    backupData: any,
    manifest: IBackupManifest,
    zipFilePath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(zipFilePath);
      const archiverFn = getArchiver();
      const archive = archiverFn('zip', {
        zlib: { level: 9 }, // Maximum compression
      });

      output.on('close', () => {
        logger.debug({ bytes: archive.pointer() }, 'Backup ZIP created');
        resolve();
      });

      archive.on('error', (err: Error) => {
        reject(err);
      });

      archive.pipe(output);

      // Add manifest
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

      // Add structured data files
      if (backupData.companies) {
        archive.append(JSON.stringify(backupData.companies, null, 2), { name: 'companies.json' });
      }
      if (backupData.users) {
        archive.append(JSON.stringify(backupData.users, null, 2), { name: 'users.json' });
      }
      if (backupData.reports) {
        archive.append(JSON.stringify(backupData.reports, null, 2), { name: 'reports.json' });
      }
      if (backupData.expenses) {
        archive.append(JSON.stringify(backupData.expenses, null, 2), { name: 'expenses.json' });
      }
      if (backupData.ocrJobs) {
        archive.append(JSON.stringify(backupData.ocrJobs, null, 2), { name: 'ocr.json' });
      }
      if (backupData.receipts) {
        archive.append(JSON.stringify(backupData.receipts, null, 2), { name: 'receipts.json' });
      }
      if (backupData.departments) {
        archive.append(JSON.stringify(backupData.departments, null, 2), { name: 'departments.json' });
      }
      if (backupData.projects) {
        archive.append(JSON.stringify(backupData.projects, null, 2), { name: 'projects.json' });
      }
      if (backupData.costCentres) {
        archive.append(JSON.stringify(backupData.costCentres, null, 2), { name: 'costCentres.json' });
      }
      if (backupData.companySettings) {
        archive.append(JSON.stringify(backupData.companySettings, null, 2), { name: 'companySettings.json' });
      }

      archive.finalize();
    });
  }

  /**
   * Get S3 storage key based on backup type
   */
  private static getStorageKey(backupType: BackupType, companyId: string | undefined, fileName: string): string {
    if (backupType === BackupType.FULL) {
      return `full-backups/${fileName}`;
    } else {
      return `company-backups/${companyId}/${fileName}`;
    }
  }

  /**
   * Get backup timestamp string
   */
  private static getBackupTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  }

  /**
   * Get all backups
   */
  static async getBackups(limit: number = 100, companyId?: string): Promise<IBackup[]> {
    const query: any = {};
    if (companyId) {
      query.companyId = new mongoose.Types.ObjectId(companyId);
    }

    return Backup.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('createdBy', 'email name')
      .populate('companyId', 'name')
      .lean() as unknown as IBackup[];
  }

  /**
   * Get backup by ID
   */
  static async getBackupById(backupId: string): Promise<IBackup | null> {
    return Backup.findById(backupId)
      .populate('createdBy', 'email name')
      .populate('companyId', 'name')
      .exec();
  }

  /**
   * Restore from backup
   * CRITICAL: Includes safety checks and ID remapping
   */
  static async restoreBackup(
    backupId: string,
    userId: string,
    restoreToCompanyId?: string, // For company backups: restore to existing or new company
    confirmText?: string // User must type "RESTORE" to confirm
  ): Promise<void> {
    // Safety check: require confirmation text
    if (!confirmText || confirmText !== 'RESTORE') {
      throw new Error('Restore confirmation required. Please type "RESTORE" to confirm.');
    }

    const backup = await Backup.findById(backupId).populate('companyId', 'name');

    if (!backup) {
      throw new Error('Backup not found');
    }

    if (backup.status !== BackupStatus.COMPLETED) {
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

        const zipBuffer = await streamToBuffer(getObjectResponse.Body);

        // Extract ZIP (using adm-zip)
        // Note: Requires: npm install adm-zip @types/adm-zip
        // @ts-ignore
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();

        // Read manifest
        const manifestEntry = zipEntries.find((e: any) => e.entryName === 'manifest.json');
        if (!manifestEntry) {
          throw new Error('Manifest not found in backup');
        }
        const manifest: IBackupManifest = JSON.parse(manifestEntry.getData().toString('utf-8'));

        // Validate backup version
        if (manifest.appVersion && !manifest.appVersion.startsWith('2.')) {
          logger.warn({ backupVersion: manifest.appVersion }, 'Backup version mismatch');
        }

        // Read data files
        const backupData: any = {};
        const fileMap: { [key: string]: string } = {
          'companies.json': 'companies',
          'users.json': 'users',
          'reports.json': 'reports',
          'expenses.json': 'expenses',
          'ocr.json': 'ocrJobs',
          'receipts.json': 'receipts',
          'departments.json': 'departments',
          'projects.json': 'projects',
          'costCentres.json': 'costCentres',
          'companySettings.json': 'companySettings',
        };

        for (const [fileName, dataKey] of Object.entries(fileMap)) {
          const entry = zipEntries.find((e: any) => e.entryName === fileName);
          if (entry) {
            backupData[dataKey] = JSON.parse(entry.getData().toString('utf-8'));
          }
        }

        // Perform restore based on backup type
        if (backup.backupType === BackupType.FULL) {
          await this.restoreFullBackup(db, backupData, manifest);
        } else {
          await this.restoreCompanyBackup(db, backupData, manifest, restoreToCompanyId);
        }

        logger.info({ backupId, backupType: backup.backupType }, 'Backup restored successfully');

        // Audit log
        await AuditService.log(
          userId,
          'Backup',
          backupId.toString(),
          AuditAction.BACKUP_RESTORED,
          {
            backupType: backup.backupType,
            companyId: backup.companyId?.toString() || null,
            restoreToCompanyId: restoreToCompanyId || null,
          }
        );
      } catch (error: any) {
        logger.error({ error, backupId }, 'Backup restore failed');
        throw error;
      }
    });
  }

  /**
   * Restore full system backup
   */
  private static async restoreFullBackup(db: any, backupData: any, _manifest: IBackupManifest): Promise<void> {
    // Clear existing collections (except system collections)
    const existingCollections = await db.listCollections().toArray();
    for (const collectionInfo of existingCollections) {
      const collectionName = collectionInfo.name;
      if (!collectionName.startsWith('system.') && collectionName !== 'backups') {
        await db.collection(collectionName).deleteMany({});
      }
    }

    // Restore collections in order (respecting dependencies)
    // Map: dataKey -> MongoDB collection name
    const collectionMap: { [key: string]: string } = {
      companies: 'companies',
      departments: 'departments',
      projects: 'projects',
      costCentres: 'costcentres',
      users: 'users',
      companySettings: 'companysettings',
      receipts: 'receipts',
      ocrJobs: 'ocrjobs',
      reports: 'expensereports',
      expenses: 'expenses',
    };

    const restoreOrder = [
      'companies',
      'departments',
      'projects',
      'costCentres',
      'users',
      'companySettings',
      'receipts',
      'ocrJobs',
      'reports',
      'expenses',
    ];

    for (const dataKey of restoreOrder) {
      const collectionName = collectionMap[dataKey];
      const documents = backupData[dataKey];
      if (Array.isArray(documents) && documents.length > 0) {
        // Keep original _id for referential integrity
        const cleanDocuments = documents.map((doc: any) => {
          const { _id, ...rest } = doc;
          return { 
            ...rest, 
            _id: _id ? new mongoose.Types.ObjectId(_id) : new mongoose.Types.ObjectId(),
            // Convert date strings back to Date objects
            ...(rest.createdAt && { createdAt: new Date(rest.createdAt) }),
            ...(rest.updatedAt && { updatedAt: new Date(rest.updatedAt) }),
            ...(rest.expenseDate && { expenseDate: new Date(rest.expenseDate) }),
            ...(rest.fromDate && { fromDate: new Date(rest.fromDate) }),
            ...(rest.toDate && { toDate: new Date(rest.toDate) }),
            ...(rest.approvedAt && { approvedAt: new Date(rest.approvedAt) }),
            ...(rest.submittedAt && { submittedAt: new Date(rest.submittedAt) }),
            ...(rest.rejectedAt && { rejectedAt: new Date(rest.rejectedAt) }),
            ...(rest.completedAt && { completedAt: new Date(rest.completedAt) }),
          };
        });
        await db.collection(collectionName).insertMany(cleanDocuments);
      }
    }
  }

  /**
   * Restore company backup
   */
  private static async restoreCompanyBackup(
    db: any,
    backupData: any,
    manifest: IBackupManifest,
    restoreToCompanyId?: string
  ): Promise<void> {
    if (!manifest.companyId) {
      throw new Error('Company ID not found in backup manifest');
    }

    const sourceCompanyId = new mongoose.Types.ObjectId(manifest.companyId);
    const targetCompanyId = restoreToCompanyId
      ? new mongoose.Types.ObjectId(restoreToCompanyId)
      : sourceCompanyId;

    // ID remapping map
    const idMap: Map<string, mongoose.Types.ObjectId> = new Map();

    // Step 1: Restore or update company
    if (backupData.companies && backupData.companies.length > 0) {
      const companyData = backupData.companies[0];
      const existingCompany = await db.collection('companies').findOne({ _id: targetCompanyId });

      if (existingCompany) {
        // Update existing company
        await db.collection('companies').updateOne(
          { _id: targetCompanyId },
          { $set: { ...companyData, _id: targetCompanyId } }
        );
      } else {
        // Create new company
        await db.collection('companies').insertOne({
          ...companyData,
          _id: targetCompanyId,
        });
      }
      idMap.set(manifest.companyId, targetCompanyId);
    }

    // Step 2: Delete existing company data (will be replaced by backup)
    // Note: In production, consider soft-delete for rollback safety
    const companyUsers = await User.find({ companyId: targetCompanyId }).select('_id').lean();
    const userIds = companyUsers.map(u => u._id);
    
    // Delete in reverse dependency order
    await db.collection('expenses').deleteMany({ userId: { $in: userIds } });
    await db.collection('expensereports').deleteMany({ userId: { $in: userIds } });
    await db.collection('ocrjobs').deleteMany({ 
      receiptId: { $in: await db.collection('receipts').find({ userId: { $in: userIds } }).map((r: any) => r._id).toArray() }
    });
    await db.collection('receipts').deleteMany({ userId: { $in: userIds } });
    await db.collection('users').deleteMany({ companyId: targetCompanyId });
    await db.collection('departments').deleteMany({ companyId: targetCompanyId });
    await db.collection('projects').deleteMany({ companyId: targetCompanyId });
    await db.collection('costcentres').deleteMany({ companyId: targetCompanyId });
    await db.collection('companysettings').deleteMany({ companyId: targetCompanyId });

    // Step 3: Restore with ID remapping
    // Map old IDs to new IDs for foreign key relationships

    // Restore departments
    if (backupData.departments) {
      const departments = backupData.departments.map((dept: any) => {
        const newId = new mongoose.Types.ObjectId();
        idMap.set(dept._id.toString(), newId);
        return {
          ...dept,
          _id: newId,
          companyId: targetCompanyId,
        };
      });
      await db.collection('departments').insertMany(departments);
    }

    // Restore projects
    if (backupData.projects) {
      const projects = backupData.projects.map((proj: any) => {
        const newId = new mongoose.Types.ObjectId();
        idMap.set(proj._id.toString(), newId);
        return {
          ...proj,
          _id: newId,
          companyId: targetCompanyId,
        };
      });
      await db.collection('projects').insertMany(projects);
    }

    // Restore cost centres
    if (backupData.costCentres) {
      const costCentres = backupData.costCentres.map((cc: any) => {
        const newId = new mongoose.Types.ObjectId();
        idMap.set(cc._id.toString(), newId);
        return {
          ...cc,
          _id: newId,
          companyId: targetCompanyId,
        };
      });
      await db.collection('costcentres').insertMany(costCentres);
    }

    // Restore users (map companyId and managerId)
    // First pass: create all users without managerId mapping
    const userIdMap: Map<string, mongoose.Types.ObjectId> = new Map();
    if (backupData.users) {
      const usersFirstPass = backupData.users.map((user: any) => {
        const newId = new mongoose.Types.ObjectId();
        userIdMap.set(user._id?.toString() || '', newId);
        return {
          ...user,
          _id: newId,
          companyId: targetCompanyId,
          // managerId will be mapped in second pass
          createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
          updatedAt: user.updatedAt ? new Date(user.updatedAt) : new Date(),
          lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt) : user.lastLoginAt,
        };
      });
      await db.collection('users').insertMany(usersFirstPass);
      
      // Second pass: update managerId references
      for (const user of backupData.users) {
        const newUserId = userIdMap.get(user._id?.toString() || '');
        if (newUserId && user.managerId) {
          const newManagerId = userIdMap.get(user.managerId.toString());
          if (newManagerId) {
            await db.collection('users').updateOne(
              { _id: newUserId },
              { $set: { managerId: newManagerId } }
            );
          }
        }
      }
    }

    // Restore receipts
    if (backupData.receipts) {
      const receipts = backupData.receipts.map((receipt: any) => {
        const newId = new mongoose.Types.ObjectId();
        idMap.set(receipt._id?.toString() || '', newId);
        return {
          ...receipt,
          _id: newId,
          userId: userIdMap.get(receipt.userId?.toString()) || receipt.userId,
          createdAt: receipt.createdAt ? new Date(receipt.createdAt) : new Date(),
          updatedAt: receipt.updatedAt ? new Date(receipt.updatedAt) : new Date(),
        };
      });
      await db.collection('receipts').insertMany(receipts);
    }

    // Restore OCR jobs (after receipts)
    if (backupData.ocrJobs) {
      const ocrJobs = backupData.ocrJobs.map((ocr: any) => ({
        ...ocr,
        _id: new mongoose.Types.ObjectId(),
        receiptId: idMap.get(ocr.receiptId?.toString()) || new mongoose.Types.ObjectId(ocr.receiptId),
        completedAt: ocr.completedAt ? new Date(ocr.completedAt) : ocr.completedAt,
        createdAt: ocr.createdAt ? new Date(ocr.createdAt) : new Date(),
        updatedAt: ocr.updatedAt ? new Date(ocr.updatedAt) : new Date(),
      }));
      await db.collection('ocrjobs').insertMany(ocrJobs);
    }

    // Map report IDs for expense restoration (must be before reports are restored)
    const reportIdMap: Map<string, mongoose.Types.ObjectId> = new Map();
    if (backupData.reports) {
      // Create mapping from old report IDs to new report IDs
      backupData.reports.forEach((report: any) => {
        const newId = new mongoose.Types.ObjectId();
        const oldId = report._id?.toString() || '';
        reportIdMap.set(oldId, newId);
      });
    }

    // Restore reports (map userId and related IDs) - must be before expenses
    if (backupData.reports) {
      const reports = backupData.reports.map((report: any) => {
        const oldId = report._id?.toString() || '';
        const newId = reportIdMap.get(oldId) || new mongoose.Types.ObjectId();
        return {
          ...report,
          _id: newId,
          userId: userIdMap.get(report.userId?.toString()) || report.userId,
          projectId: report.projectId && idMap.has(report.projectId.toString())
            ? idMap.get(report.projectId.toString())
            : report.projectId,
          costCentreId: report.costCentreId && idMap.has(report.costCentreId.toString())
            ? idMap.get(report.costCentreId.toString())
            : report.costCentreId,
          // Map approver user IDs
          approvers: report.approvers?.map((approver: any) => ({
            ...approver,
            userId: userIdMap.get(approver.userId?.toString()) || approver.userId,
            decidedAt: approver.decidedAt ? new Date(approver.decidedAt) : approver.decidedAt,
          })) || [],
          // Convert date strings
          fromDate: report.fromDate ? new Date(report.fromDate) : report.fromDate,
          toDate: report.toDate ? new Date(report.toDate) : report.toDate,
          submittedAt: report.submittedAt ? new Date(report.submittedAt) : report.submittedAt,
          approvedAt: report.approvedAt ? new Date(report.approvedAt) : report.approvedAt,
          rejectedAt: report.rejectedAt ? new Date(report.rejectedAt) : report.rejectedAt,
          createdAt: report.createdAt ? new Date(report.createdAt) : new Date(),
          updatedAt: report.updatedAt ? new Date(report.updatedAt) : new Date(),
        };
      });
      await db.collection('expensereports').insertMany(reports);
    }

    // Restore expenses (map userId, reportId, receiptIds, etc.) - after reports
    if (backupData.expenses) {
      const expenses = backupData.expenses.map((expense: any) => {
        const newId = new mongoose.Types.ObjectId();
        return {
          ...expense,
          _id: newId,
          userId: userIdMap.get(expense.userId?.toString()) || expense.userId,
          reportId: expense.reportId && reportIdMap.has(expense.reportId.toString())
            ? reportIdMap.get(expense.reportId.toString())
            : expense.reportId,
          receiptIds: expense.receiptIds?.map((rid: any) => 
            idMap.get(rid?.toString()) || new mongoose.Types.ObjectId(rid)
          ) || [],
          receiptPrimaryId: expense.receiptPrimaryId && idMap.has(expense.receiptPrimaryId?.toString())
            ? idMap.get(expense.receiptPrimaryId.toString())
            : expense.receiptPrimaryId,
          categoryId: expense.categoryId ? new mongoose.Types.ObjectId(expense.categoryId) : expense.categoryId,
          costCentreId: expense.costCentreId && idMap.has(expense.costCentreId?.toString())
            ? idMap.get(expense.costCentreId.toString())
            : expense.costCentreId,
          projectId: expense.projectId && idMap.has(expense.projectId?.toString())
            ? idMap.get(expense.projectId.toString())
            : expense.projectId,
          // Convert date strings
          expenseDate: expense.expenseDate ? new Date(expense.expenseDate) : expense.expenseDate,
          invoiceDate: expense.invoiceDate ? new Date(expense.invoiceDate) : expense.invoiceDate,
          createdAt: expense.createdAt ? new Date(expense.createdAt) : new Date(),
          updatedAt: expense.updatedAt ? new Date(expense.updatedAt) : new Date(),
        };
      });
      await db.collection('expenses').insertMany(expenses);
    }

    // Restore company settings
    if (backupData.companySettings) {
      const settings = backupData.companySettings.map((setting: any) => ({
        ...setting,
        _id: new mongoose.Types.ObjectId(),
        companyId: targetCompanyId,
      }));
      await db.collection('companysettings').insertMany(settings);
    }
  }

  /**
   * Get presigned download URL for backup
   */
  static async getBackupDownloadUrl(backupId: string, expiresIn: number = 3600): Promise<string> {
    const backup = await Backup.findById(backupId);

    if (!backup || !backup.storageKey) {
      throw new Error('Backup not found or no storage key');
    }

    // Generate presigned URL
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');

    const bucket = getS3Bucket('backups');
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: backup.storageKey,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn });
    return url;
  }

  /**
   * Delete backup
   */
  static async deleteBackup(backupId: string, userId?: string): Promise<void> {
    const backup = await Backup.findById(backupId);

    if (!backup) {
      throw new Error('Backup not found');
    }

    // Delete from S3
    if (backup.storageKey) {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const bucket = getS3Bucket('backups');
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: backup.storageKey,
        })
      );
    }

    // Delete from database
    await Backup.findByIdAndDelete(backupId);

    logger.info({ backupId }, 'Backup deleted');

    // Audit log
    if (userId) {
      await AuditService.log(
        userId,
        'Backup',
        backupId.toString(),
        AuditAction.BACKUP_DELETED,
        {
          storageKey: backup.storageKey,
        }
      );
    }
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

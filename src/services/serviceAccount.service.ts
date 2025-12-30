import crypto from 'crypto';
import mongoose from 'mongoose';

import { ServiceAccount } from '../models/ServiceAccount';
import { AuditService } from './audit.service';
import { AuditAction } from '../utils/enums';

import { logger } from '@/config/logger';

export interface CreateServiceAccountDto {
  name: string;
  companyId?: string;
  allowedEndpoints: string[];
  expiresAt?: Date;
}

export interface ServiceAccountResponse {
  id: string;
  name: string;
  companyId?: string;
  allowedEndpoints: string[];
  expiresAt?: Date;
  isActive: boolean;
  lastUsedAt?: Date;
  createdAt: Date;
  apiKey?: string; // Only returned on creation
}

/**
 * Generate a secure random API key
 */
function generateApiKey(): string {
  // Generate 32 bytes of random data and encode as base64url
  const randomBytes = crypto.randomBytes(32);
  // Use base64url encoding (URL-safe, no padding)
  return randomBytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 43); // 43 chars = 32 bytes in base64url
}

/**
 * Hash API key using bcrypt
 */
async function hashApiKey(apiKey: string): Promise<string> {
  const bcrypt = await import('bcrypt');
  const saltRounds = 12;
  return bcrypt.default.hash(apiKey, saltRounds);
}

export class ServiceAccountService {
  /**
   * Create a new service account
   * Returns the API key ONCE - it will never be shown again
   */
  static async createServiceAccount(
    data: CreateServiceAccountDto,
    createdBy: string
  ): Promise<{ serviceAccount: ServiceAccountResponse; apiKey: string }> {
    try {
      // Generate API key
      const apiKey = generateApiKey();
      const apiKeyHash = await hashApiKey(apiKey);

      // Validate allowed endpoints
      if (!data.allowedEndpoints || data.allowedEndpoints.length === 0) {
        throw new Error('At least one allowed endpoint is required');
      }

      // Create service account
      const serviceAccount = new ServiceAccount({
        name: data.name,
        apiKeyHash,
        companyId: data.companyId
          ? new mongoose.Types.ObjectId(data.companyId)
          : undefined,
        allowedEndpoints: data.allowedEndpoints,
        expiresAt: data.expiresAt,
        isActive: true,
        createdBy: new mongoose.Types.ObjectId(createdBy),
      });

      await serviceAccount.save();

      // Audit log
      await AuditService.log(
        createdBy,
        'ServiceAccount',
        (serviceAccount._id as mongoose.Types.ObjectId).toString(),
        AuditAction.CREATE,
        {
          name: data.name,
          companyId: data.companyId,
          allowedEndpoints: data.allowedEndpoints,
        }
      );

      logger.info(
        {
          serviceAccountId: serviceAccount._id,
          createdBy,
          companyId: data.companyId,
        },
        'Service account created'
      );

      return {
        serviceAccount: {
          id: (serviceAccount._id as mongoose.Types.ObjectId).toString(),
          name: serviceAccount.name,
          companyId: serviceAccount.companyId
            ? (serviceAccount.companyId as mongoose.Types.ObjectId).toString()
            : undefined,
          allowedEndpoints: serviceAccount.allowedEndpoints,
          expiresAt: serviceAccount.expiresAt,
          isActive: serviceAccount.isActive,
          lastUsedAt: serviceAccount.lastUsedAt,
          createdAt: serviceAccount.createdAt,
        },
        apiKey, // Return plain API key ONLY ONCE
      };
    } catch (error) {
      logger.error({ error, data }, 'Error creating service account');
      throw error;
    }
  }

  /**
   * List service accounts (filtered by company if provided)
   */
  static async listServiceAccounts(
    companyId?: string
  ): Promise<ServiceAccountResponse[]> {
    try {
      const query: any = {};

      // If user is COMPANY_ADMIN, filter by their company
      if (companyId) {
        query.companyId = new mongoose.Types.ObjectId(companyId);
      }

      const serviceAccounts = await ServiceAccount.find(query)
        .select('-apiKeyHash') // Never return hashed key
        .populate('createdBy', 'name email')
        .populate('companyId', 'name')
        .sort({ createdAt: -1 })
        .exec();

      return serviceAccounts.map((sa) => ({
        id: (sa._id as mongoose.Types.ObjectId).toString(),
        name: sa.name,
        companyId: sa.companyId
          ? (sa.companyId as mongoose.Types.ObjectId).toString()
          : undefined,
        allowedEndpoints: sa.allowedEndpoints,
        expiresAt: sa.expiresAt,
        isActive: sa.isActive,
        lastUsedAt: sa.lastUsedAt,
        createdAt: sa.createdAt,
      }));
    } catch (error) {
      logger.error({ error, companyId }, 'Error listing service accounts');
      throw error;
    }
  }

  /**
   * Get service account by ID
   */
  static async getServiceAccountById(
    id: string,
    companyId?: string
  ): Promise<ServiceAccountResponse | null> {
    try {
      const query: any = { _id: new mongoose.Types.ObjectId(id) };

      if (companyId) {
        query.companyId = new mongoose.Types.ObjectId(companyId);
      }

      const serviceAccount = await ServiceAccount.findOne(query)
        .select('-apiKeyHash')
        .populate('createdBy', 'name email')
        .populate('companyId', 'name')
        .exec();

      if (!serviceAccount) {
        return null;
      }

      return {
        id: (serviceAccount._id as mongoose.Types.ObjectId).toString(),
        name: serviceAccount.name,
        companyId: serviceAccount.companyId
          ? (serviceAccount.companyId as mongoose.Types.ObjectId).toString()
          : undefined,
        allowedEndpoints: serviceAccount.allowedEndpoints,
        expiresAt: serviceAccount.expiresAt,
        isActive: serviceAccount.isActive,
        lastUsedAt: serviceAccount.lastUsedAt,
        createdAt: serviceAccount.createdAt,
      };
    } catch (error) {
      logger.error({ error, id }, 'Error getting service account');
      throw error;
    }
  }

  /**
   * Regenerate API key for a service account
   * Returns the new API key ONCE
   */
  static async regenerateApiKey(
    id: string,
    userId: string,
    companyId?: string
  ): Promise<{ serviceAccount: ServiceAccountResponse; apiKey: string }> {
    try {
      const query: any = { _id: new mongoose.Types.ObjectId(id) };

      if (companyId) {
        query.companyId = new mongoose.Types.ObjectId(companyId);
      }

      const serviceAccount = await ServiceAccount.findOne(query).exec();

      if (!serviceAccount) {
        throw new Error('Service account not found');
      }

      // Generate new API key
      const newApiKey = generateApiKey();
      const newApiKeyHash = await hashApiKey(newApiKey);

      // Update service account
      serviceAccount.apiKeyHash = newApiKeyHash;
      await serviceAccount.save();

      // Audit log
      await AuditService.log(
        userId,
        'ServiceAccount',
        id,
        AuditAction.UPDATE,
        { action: 'regenerate_api_key' }
      );

      logger.info({ serviceAccountId: id, userId }, 'Service account API key regenerated');

      return {
        serviceAccount: {
          id: (serviceAccount._id as mongoose.Types.ObjectId).toString(),
          name: serviceAccount.name,
          companyId: serviceAccount.companyId
            ? (serviceAccount.companyId as mongoose.Types.ObjectId).toString()
            : undefined,
          allowedEndpoints: serviceAccount.allowedEndpoints,
          expiresAt: serviceAccount.expiresAt,
          isActive: serviceAccount.isActive,
          lastUsedAt: serviceAccount.lastUsedAt,
          createdAt: serviceAccount.createdAt,
        },
        apiKey: newApiKey, // Return new API key ONLY ONCE
      };
    } catch (error) {
      logger.error({ error, id }, 'Error regenerating API key');
      throw error;
    }
  }

  /**
   * Delete (revoke) a service account
   */
  static async deleteServiceAccount(
    id: string,
    userId: string,
    companyId?: string
  ): Promise<void> {
    try {
      const query: any = { _id: new mongoose.Types.ObjectId(id) };

      if (companyId) {
        query.companyId = new mongoose.Types.ObjectId(companyId);
      }

      const serviceAccount = await ServiceAccount.findOne(query).exec();

      if (!serviceAccount) {
        throw new Error('Service account not found');
      }

      // Soft delete by setting isActive to false
      serviceAccount.isActive = false;
      await serviceAccount.save();

      // Audit log
      await AuditService.log(
        userId,
        'ServiceAccount',
        id,
        AuditAction.DELETE,
        { name: serviceAccount.name }
      );

      logger.info({ serviceAccountId: id, userId }, 'Service account revoked');
    } catch (error) {
      logger.error({ error, id }, 'Error deleting service account');
      throw error;
    }
  }

  /**
   * Update service account (name, endpoints, expiry)
   */
  static async updateServiceAccount(
    id: string,
    data: Partial<CreateServiceAccountDto>,
    userId: string,
    companyId?: string
  ): Promise<ServiceAccountResponse> {
    try {
      const query: any = { _id: new mongoose.Types.ObjectId(id) };

      if (companyId) {
        query.companyId = new mongoose.Types.ObjectId(companyId);
      }

      const serviceAccount = await ServiceAccount.findOne(query).exec();

      if (!serviceAccount) {
        throw new Error('Service account not found');
      }

      // Update fields
      if (data.name !== undefined) {
        serviceAccount.name = data.name;
      }
      if (data.allowedEndpoints !== undefined) {
        if (data.allowedEndpoints.length === 0) {
          throw new Error('At least one allowed endpoint is required');
        }
        serviceAccount.allowedEndpoints = data.allowedEndpoints;
      }
      if (data.expiresAt !== undefined) {
        serviceAccount.expiresAt = data.expiresAt;
      }

      await serviceAccount.save();

      // Audit log
      await AuditService.log(
        userId,
        'ServiceAccount',
        id,
        AuditAction.UPDATE,
        data
      );

      return {
        id: (serviceAccount._id as mongoose.Types.ObjectId).toString(),
        name: serviceAccount.name,
        companyId: serviceAccount.companyId
          ? (serviceAccount.companyId as mongoose.Types.ObjectId).toString()
          : undefined,
        allowedEndpoints: serviceAccount.allowedEndpoints,
        expiresAt: serviceAccount.expiresAt,
        isActive: serviceAccount.isActive,
        lastUsedAt: serviceAccount.lastUsedAt,
        createdAt: serviceAccount.createdAt,
      };
    } catch (error) {
      logger.error({ error, id, data }, 'Error updating service account');
      throw error;
    }
  }
}


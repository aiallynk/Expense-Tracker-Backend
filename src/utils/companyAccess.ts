import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { User } from '../models/User';

import { logger } from '@/config/logger';

/**
 * Get company ID for a user from AuthRequest
 * Handles both regular users (User collection) and company admins (CompanyAdmin collection)
 * 
 * @param req - Authenticated request with user info
 * @returns Company ID string or undefined if not found
 */
export async function getUserCompanyId(req: AuthRequest): Promise<string | undefined> {
  if (!req.user) {
    return undefined;
  }

  // If user is COMPANY_ADMIN, look in CompanyAdmin collection
  if (req.user.role === 'COMPANY_ADMIN') {
    try {
      const companyAdmin = await CompanyAdmin.findById(req.user.id)
        .select('companyId')
        .exec();
      return companyAdmin?.companyId?.toString();
    } catch (error) {
      logger.error({ error, userId: req.user.id }, 'Error getting companyId for COMPANY_ADMIN');
      return undefined;
    }
  }

  // For SERVICE_ACCOUNT, companyId is already in req.user
  if (req.user.role === 'SERVICE_ACCOUNT' && req.user.companyId) {
    return req.user.companyId;
  }

  // For other roles, look in User collection
  try {
    const user = await User.findById(req.user.id)
      .select('companyId')
      .exec();
    return user?.companyId?.toString();
  } catch (error) {
    logger.error({ error, userId: req.user.id }, 'Error getting companyId for User');
    return undefined;
  }
}

/**
 * Get all user IDs for a given company
 * Used to filter queries by company users
 * 
 * @param companyId - Company ID
 * @returns Array of user ObjectIds
 */
export async function getCompanyUserIds(companyId: string): Promise<mongoose.Types.ObjectId[]> {
  try {
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      return [];
    }

    const companyObjectId = new mongoose.Types.ObjectId(companyId);
    const users = await User.find({ companyId: companyObjectId })
      .select('_id')
      .exec();
    
    return users.map(u => u._id as mongoose.Types.ObjectId);
  } catch (error) {
    logger.error({ error, companyId }, 'Error getting company user IDs');
    return [];
  }
}

/**
 * Validate that a user can access a resource from a specific company
 * 
 * Rules:
 * - SUPER_ADMIN can access any company
 * - All other roles can only access their own company
 * 
 * @param req - Authenticated request
 * @param resourceCompanyId - Company ID of the resource being accessed
 * @returns true if access is allowed, false otherwise
 */
export async function validateCompanyAccess(
  req: AuthRequest,
  resourceCompanyId: string
): Promise<boolean> {
  if (!req.user) {
    return false;
  }

  // SUPER_ADMIN can access any company
  if (req.user.role === 'SUPER_ADMIN') {
    return true;
  }

  // Get user's company ID
  const userCompanyId = await getUserCompanyId(req);
  
  if (!userCompanyId) {
    return false;
  }

  // User can only access resources from their own company
  return userCompanyId === resourceCompanyId;
}

/**
 * Build a MongoDB query filter that restricts results to user's company
 * 
 * For reports/expenses, filters by userId in company users
 * For other resources, filters by companyId directly
 * 
 * @param req - Authenticated request
 * @param baseQuery - Base query object to add company filter to
 * @param filterType - 'users' for userId filter, 'direct' for companyId filter
 * @returns Query object with company filter added (or original if SUPER_ADMIN)
 */
export async function buildCompanyQuery(
  req: AuthRequest,
  baseQuery: any = {},
  filterType: 'users' | 'direct' = 'users'
): Promise<any> {
  if (!req.user) {
    return baseQuery;
  }

  // SUPER_ADMIN can see all data
  if (req.user.role === 'SUPER_ADMIN') {
    return baseQuery;
  }

  const companyId = await getUserCompanyId(req);
  
  if (!companyId) {
    // If user has no company, return empty result query
    return { ...baseQuery, _id: { $in: [] } };
  }

  if (filterType === 'users') {
    // For reports/expenses: filter by userId in company users
    const userIds = await getCompanyUserIds(companyId);
    if (userIds.length === 0) {
      // No users in company, return empty result
      return { ...baseQuery, userId: { $in: [] } };
    }
    
    // If baseQuery already has a userId filter, respect it but ensure it's within company users
    if (baseQuery.userId) {
      // Handle different userId filter types
      if (typeof baseQuery.userId === 'string') {
        // String userId - validate and convert to ObjectId
        if (!mongoose.Types.ObjectId.isValid(baseQuery.userId)) {
          return { ...baseQuery, userId: { $in: [] } };
        }
        const requestedUserId = new mongoose.Types.ObjectId(baseQuery.userId);
        const isInCompany = userIds.some(id => id.toString() === requestedUserId.toString());
        if (!isInCompany) {
          return { ...baseQuery, userId: { $in: [] } };
        }
        return {
          ...baseQuery,
          userId: requestedUserId
        };
      } else if (baseQuery.userId instanceof mongoose.Types.ObjectId) {
        // Already ObjectId - validate it's in company
        const isInCompany = userIds.some(id => id.toString() === baseQuery.userId.toString());
        if (!isInCompany) {
          return { ...baseQuery, userId: { $in: [] } };
        }
        // Keep the existing userId filter
        return baseQuery;
      } else if (baseQuery.userId.$in) {
        // $in query - intersect with company users
        const requestedIds = Array.isArray(baseQuery.userId.$in) 
          ? baseQuery.userId.$in.map((id: any) => {
              if (typeof id === 'string') {
                return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
              }
              return id instanceof mongoose.Types.ObjectId ? id : null;
            }).filter((id: mongoose.Types.ObjectId | null): id is mongoose.Types.ObjectId => id !== null)
          : [];
        const intersectedIds = requestedIds.filter((id: mongoose.Types.ObjectId) =>
          userIds.some(companyId => companyId.toString() === id.toString())
        );
        return {
          ...baseQuery,
          userId: intersectedIds.length > 0 ? { $in: intersectedIds } : { $in: [] }
        };
      } else {
        // Other operators (e.g., $ne, $exists) - intersect by filtering company users
        // This is complex, so we'll apply the operator to company users
        // For now, fall back to company users filter
        return {
          ...baseQuery,
          userId: { $in: userIds },
        };
      }
    }
    
    // No userId filter in baseQuery, filter by all company users
    return {
      ...baseQuery,
      userId: { $in: userIds },
    };
  } else {
    // For other resources: filter by companyId directly
    return {
      ...baseQuery,
      companyId: new mongoose.Types.ObjectId(companyId),
    };
  }
}

/**
 * Check if a user is a SUPER_ADMIN
 * 
 * @param req - Authenticated request
 * @returns true if user is SUPER_ADMIN
 */
export function isSuperAdmin(req: AuthRequest): boolean {
  return req.user?.role === 'SUPER_ADMIN';
}

/**
 * Check if a user is a COMPANY_ADMIN
 * 
 * @param req - Authenticated request
 * @returns true if user is COMPANY_ADMIN
 */
export function isCompanyAdmin(req: AuthRequest): boolean {
  return req.user?.role === 'COMPANY_ADMIN';
}


import { Response, NextFunction } from 'express';

import { UserRole } from '../utils/enums';

import { AuthRequest } from './auth.middleware';

export const requireRole = (...allowedRoles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    // Service accounts are handled separately and should not reach here
    // If they do, deny access (service accounts use different middleware)
    if (req.user.role === 'SERVICE_ACCOUNT') {
      res.status(403).json({
        success: false,
        message: 'Service accounts cannot access this endpoint',
        code: 'FORBIDDEN',
      });
      return;
    }

    // Check if user role matches any allowed role (handle both string and enum)
    const userRole = req.user.role;
    const allowedRoleStrings = allowedRoles.map(role => role.toString());
    const isAllowed = allowedRoleStrings.includes(userRole) || allowedRoles.includes(userRole as UserRole);
    
    if (!isAllowed) {
      res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        code: 'FORBIDDEN',
      });
      return;
    }

    next();
  };
};

export const requireAdmin = requireRole(UserRole.ADMIN, UserRole.BUSINESS_HEAD, UserRole.COMPANY_ADMIN, UserRole.SUPER_ADMIN);

export const requireCompanyAdmin = requireRole(UserRole.COMPANY_ADMIN, UserRole.SUPER_ADMIN);


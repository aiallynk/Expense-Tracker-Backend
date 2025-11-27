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

    if (!allowedRoles.includes(req.user.role as UserRole)) {
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


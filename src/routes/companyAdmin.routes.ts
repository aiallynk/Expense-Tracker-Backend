import { Router } from 'express';

import { CompanyAdminController } from '../controllers/companyAdmin.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createCompanyAdminSchema,
  updateCompanyAdminSchema,
  resetCompanyAdminPasswordSchema,
} from '../utils/dtoTypes';
import { UserRole } from '../utils/enums';
// Import CompanyAdmin model to ensure it's registered with Mongoose
import '../models/CompanyAdmin';

const router = Router();

// All routes require authentication and SUPER_ADMIN role
router.use(authMiddleware);
router.use(requireRole(UserRole.SUPER_ADMIN));

// Company Admin routes
// POST /api/v1/companies/:companyId/admins - Create company admin
router.post(
  '/:companyId/admins',
  validate(createCompanyAdminSchema),
  CompanyAdminController.createCompanyAdmin
);

// GET /api/v1/companies/:companyId/admins - Get all company admins
router.get(
  '/:companyId/admins',
  CompanyAdminController.getCompanyAdmins
);

// GET /api/v1/companies/:companyId/admins/:adminId - Get specific company admin
router.get(
  '/:companyId/admins/:adminId',
  CompanyAdminController.getCompanyAdminById
);

// PUT /api/v1/companies/:companyId/admins/:adminId - Update company admin
router.put(
  '/:companyId/admins/:adminId',
  validate(updateCompanyAdminSchema),
  CompanyAdminController.updateCompanyAdmin
);

// DELETE /api/v1/companies/:companyId/admins/:adminId - Delete company admin
router.delete(
  '/:companyId/admins/:adminId',
  CompanyAdminController.deleteCompanyAdmin
);

// POST /api/v1/companies/:companyId/admins/:adminId/reset-password - Reset password
router.post(
  '/:companyId/admins/:adminId/reset-password',
  validate(resetCompanyAdminPasswordSchema),
  CompanyAdminController.resetCompanyAdminPassword
);

export default router;


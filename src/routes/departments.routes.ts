import { Router } from 'express';

import { DepartmentsController } from '../controllers/departments.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
} from '../utils/dtoTypes';
import { UserRole } from '../utils/enums';
import '../models/Department';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Get all departments (accessible to company admin, super admin, and users with companyId)
router.get('/', DepartmentsController.getAll);

// Initialize default departments (company admin only)
router.post('/initialize-defaults', requireRole(UserRole.COMPANY_ADMIN), DepartmentsController.initializeDefaults);

// Get department by ID
router.get('/:id', DepartmentsController.getById);

// Create department (company admin only)
router.post(
  '/',
  requireRole(UserRole.COMPANY_ADMIN),
  validate(createDepartmentSchema),
  DepartmentsController.create
);

// Update department (company admin only)
router.patch(
  '/:id',
  requireRole(UserRole.COMPANY_ADMIN),
  validate(updateDepartmentSchema),
  DepartmentsController.update
);

// Delete department (company admin only)
router.delete(
  '/:id',
  requireRole(UserRole.COMPANY_ADMIN),
  DepartmentsController.delete
);

export default router;


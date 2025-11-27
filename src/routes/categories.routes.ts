import { Router } from 'express';

import { CategoriesController } from '../controllers/categories.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireAdmin, requireCompanyAdmin } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createCategorySchema,
  updateCategorySchema,
} from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// User endpoints
router.get('/', CategoriesController.getAll);
router.get('/name/:name', CategoriesController.getOrCreateByName);
router.get('/:id', CategoriesController.getById);

// Admin endpoints (company admin or super admin)
router.get('/admin/list', requireCompanyAdmin, CategoriesController.getAdminCategories);
router.post('/admin/initialize', requireCompanyAdmin, CategoriesController.initializeDefaults);

router.post(
  '/',
  requireCompanyAdmin,
  validate(createCategorySchema),
  CategoriesController.create
);
router.patch(
  '/:id',
  requireCompanyAdmin,
  validate(updateCategorySchema),
  CategoriesController.update
);
router.delete('/:id', requireCompanyAdmin, CategoriesController.delete);

export default router;

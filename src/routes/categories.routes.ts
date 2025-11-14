import { Router } from 'express';
import { CategoriesController } from '../controllers/categories.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createCategorySchema,
  updateCategorySchema,
} from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.get('/', CategoriesController.getAll);
router.get('/:id', CategoriesController.getById);

// Admin only
router.post(
  '/',
  requireAdmin,
  validate(createCategorySchema),
  CategoriesController.create
);
router.patch(
  '/:id',
  requireAdmin,
  validate(updateCategorySchema),
  CategoriesController.update
);
router.delete('/:id', requireAdmin, CategoriesController.delete);

export default router;


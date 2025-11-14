import { Router } from 'express';
import { ProjectsController } from '../controllers/projects.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createProjectSchema,
  updateProjectSchema,
} from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.get('/', ProjectsController.getAll);
router.get('/:id', ProjectsController.getById);

// Admin only
router.post('/', requireAdmin, validate(createProjectSchema), ProjectsController.create);
router.patch(
  '/:id',
  requireAdmin,
  validate(updateProjectSchema),
  ProjectsController.update
);
router.delete('/:id', requireAdmin, ProjectsController.delete);

export default router;


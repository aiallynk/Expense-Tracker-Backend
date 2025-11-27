import { Router } from 'express';

import { ProjectsController } from '../controllers/projects.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireCompanyAdmin } from '../middleware/role.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// User endpoints
router.get('/', ProjectsController.getAll);
router.get('/:id', ProjectsController.getById);

// Admin endpoints (company admin)
router.get('/admin/list', requireCompanyAdmin, ProjectsController.getAdminProjects);

router.post('/', requireCompanyAdmin, ProjectsController.create);
router.patch('/:id', requireCompanyAdmin, ProjectsController.update);
router.delete('/:id', requireCompanyAdmin, ProjectsController.delete);

export default router;

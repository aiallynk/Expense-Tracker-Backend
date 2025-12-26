import { Router } from 'express';

import { CostCentresController } from '../controllers/costCentres.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireCompanyAdmin } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createCostCentreSchema,
  updateCostCentreSchema,
} from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// User endpoints
router.get('/', CostCentresController.getAll);
router.get('/name/:name', CostCentresController.getOrCreateByName);
router.get('/:id', CostCentresController.getById);

// Admin endpoints (company admin or super admin)
router.get('/admin/list', requireCompanyAdmin, CostCentresController.getAdminCostCentres);

router.post(
  '/',
  requireCompanyAdmin,
  validate(createCostCentreSchema),
  CostCentresController.create
);
router.patch(
  '/:id',
  requireCompanyAdmin,
  validate(updateCostCentreSchema),
  CostCentresController.update
);
router.delete('/:id', requireCompanyAdmin, CostCentresController.delete);

export default router;


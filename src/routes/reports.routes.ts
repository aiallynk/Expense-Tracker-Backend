import { Router } from 'express';
import { ReportsController } from '../controllers/reports.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createReportSchema,
  updateReportSchema,
} from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.post('/', validate(createReportSchema), ReportsController.create);
router.get('/', ReportsController.getAll);
router.get('/:id', ReportsController.getById);
router.patch('/:id', validate(updateReportSchema), ReportsController.update);
router.post('/:id/submit', ReportsController.submit);

export default router;


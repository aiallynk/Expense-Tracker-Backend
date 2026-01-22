import { Router } from 'express';

import { VoucherReturnController } from '../controllers/voucherReturn.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.post('/', VoucherReturnController.requestReturn);
router.get('/', VoucherReturnController.list);
router.post('/:id/approve', VoucherReturnController.approve);
router.post('/:id/reject', VoucherReturnController.reject);

export default router;

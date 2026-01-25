import { Router } from 'express';

import { VoucherController } from '../controllers/voucher.controller';
import { VoucherReturnController } from '../controllers/voucherReturn.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.post('/', VoucherController.create);
router.get('/', VoucherController.list);
router.get('/dashboard', VoucherController.getDashboard);
router.get('/:id', VoucherController.getById);
router.get('/:id/usage-history', VoucherController.getUsageHistory);
router.post('/:id/admin-return', VoucherReturnController.adminReturn);
router.get('/:id/ledger', VoucherController.getLedger);

export default router;

import { Router } from 'express';

import { AdvanceCashController } from '../controllers/advanceCash.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

router.get('/balance', AdvanceCashController.getBalance);
router.get('/', AdvanceCashController.listMine);
router.post('/', AdvanceCashController.create);

export default router;



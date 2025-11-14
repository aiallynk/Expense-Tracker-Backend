import { Router } from 'express';
import { UsersController } from '../controllers/users.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import { updateProfileSchema } from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.get('/me', UsersController.getMe);
router.patch('/me', validate(updateProfileSchema), UsersController.updateProfile);

// Admin only
router.get('/', requireAdmin, UsersController.getAllUsers);

export default router;


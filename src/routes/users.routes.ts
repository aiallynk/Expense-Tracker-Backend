import { Router } from 'express';

import { UsersController } from '../controllers/users.controller';
import { BrandingController } from '../controllers/branding.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import { updateProfileSchema, createUserSchema, updateUserSchema } from '../utils/dtoTypes';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.get('/me', UsersController.getMe);
router.patch('/me', validate(updateProfileSchema), UsersController.updateProfile);

// Get companies list for selection (accessible to users without company)
router.get('/companies', UsersController.getCompanies);

// Get company logo (accessible to all authenticated users)
router.get('/logo', BrandingController.getLogo);

// Admin only
router.get('/', requireAdmin, UsersController.getAllUsers);
router.post('/', requireAdmin, validate(createUserSchema), UsersController.createUser);
router.get('/:id', requireAdmin, UsersController.getUserById);
router.patch('/:id', requireAdmin, validate(updateUserSchema), UsersController.updateUser);

export default router;


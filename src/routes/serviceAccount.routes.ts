import { Router } from 'express';

import { ServiceAccountController } from '../controllers/serviceAccount.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { UserRole } from '../utils/enums';

const router = Router();

// All routes require authentication and COMPANY_ADMIN or SUPER_ADMIN role
router.use(authMiddleware);
router.use(requireRole(UserRole.COMPANY_ADMIN, UserRole.SUPER_ADMIN));

// Import ServiceAccount model to ensure it's registered
import '../models/ServiceAccount';

// Create service account
router.post('/', ServiceAccountController.create);

// List service accounts
router.get('/', ServiceAccountController.list);

// Get service account by ID
router.get('/:id', ServiceAccountController.getById);

// Update service account
router.patch('/:id', ServiceAccountController.update);

// Regenerate API key
router.post('/:id/regenerate-key', ServiceAccountController.regenerateKey);

// Delete (revoke) service account
router.delete('/:id', ServiceAccountController.delete);

export default router;


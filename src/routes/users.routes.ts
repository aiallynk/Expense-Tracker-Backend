import { Router } from 'express';
import multer from 'multer';

import { BrandingController } from '../controllers/branding.controller';
import { UsersController } from '../controllers/users.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/role.middleware';
import { validate } from '../middleware/validate.middleware';
import { updateProfileSchema, createUserSchema, updateUserSchema, bulkUserActionSchema } from '../utils/dtoTypes';
import { loginRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

// Configure multer for profile image upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed types: jpg, jpeg, png'));
    }
  },
});

// All routes require authentication
router.use(authMiddleware);

router.get('/me', UsersController.getMe);
router.patch('/me', validate(updateProfileSchema), UsersController.updateProfile);
router.post(
  '/profile/upload-image',
  loginRateLimiter,
  upload.single('image'),
  UsersController.uploadProfileImage
);

// Get companies list for selection (accessible to users without company)
router.get('/companies', UsersController.getCompanies);

// Get company logo (accessible to all authenticated users)
router.get('/logo', BrandingController.getLogo);

// Admin only
router.get('/', requireAdmin, UsersController.getAllUsers);
router.post('/', requireAdmin, validate(createUserSchema), UsersController.createUser);
router.post('/bulk-action', requireAdmin, validate(bulkUserActionSchema), UsersController.bulkAction);
router.get('/:id', requireAdmin, UsersController.getUserById);
router.patch('/:id', requireAdmin, validate(updateUserSchema), UsersController.updateUser);

export default router;


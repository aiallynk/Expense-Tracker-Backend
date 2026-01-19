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
    // Normalize MIME type (handle variations)
    const normalizedMimeType = file.mimetype.toLowerCase().trim();
    
    // Check MIME type
    const allowedMimeTypes = [
      'image/jpeg',
      'image/jpg', // Some clients send this (non-standard but common)
      'image/png',
      'image/x-png', // Alternative PNG MIME type
    ];
    
    // Also check file extension as fallback
    const fileName = file.originalname.toLowerCase();
    const hasValidExtension = 
      fileName.endsWith('.jpg') || 
      fileName.endsWith('.jpeg') || 
      fileName.endsWith('.png');
    
    // Accept if MIME type matches OR if extension matches (for cases where MIME type is wrong/missing)
    if (allowedMimeTypes.includes(normalizedMimeType) || hasValidExtension) {
      cb(null, true);
    } else {
      // Log the actual MIME type received for debugging
      const { logger } = require('../config/logger');
      logger.warn({ 
        mimetype: file.mimetype, 
        originalname: file.originalname,
        fieldname: file.fieldname 
      }, 'Profile image upload rejected - invalid file type');
      cb(new Error(`Invalid file type. Received: ${file.mimetype || 'unknown'}, Allowed types: jpg, jpeg, png`));
    }
  },
});

// All routes require authentication
router.use(authMiddleware);

router.get('/me', UsersController.getMe);
router.patch('/me', validate(updateProfileSchema), UsersController.updateProfile);
router.get('/profile/image-url', UsersController.getProfileImageUrl);
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


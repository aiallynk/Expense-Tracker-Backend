import { Router } from 'express';
import multer from 'multer';

import { ProjectStakeholderController } from '../controllers/projectStakeholder.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireCompanyAdmin } from '../middleware/role.middleware';

// Configure multer for CSV uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (_req, file, cb) => {
    // Accept only CSV files
    if (file.mimetype === 'text/csv' ||
        file.mimetype === 'application/vnd.ms-excel' ||
        file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
});

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Company admin only routes
router.post('/assign', requireCompanyAdmin, ProjectStakeholderController.assignStakeholder);
router.delete('/:projectId/stakeholders/:userId', requireCompanyAdmin, ProjectStakeholderController.removeStakeholder);
router.post('/bulk-assign', requireCompanyAdmin, ProjectStakeholderController.bulkAssignStakeholders);
router.post('/validate-users', requireCompanyAdmin, ProjectStakeholderController.validateUsersForUpload);
router.post('/upload-csv', requireCompanyAdmin, upload.single('csvFile'), ProjectStakeholderController.uploadStakeholdersCSV);

// General routes (authenticated users can view)
router.get('/:projectId/stakeholders', ProjectStakeholderController.getProjectStakeholders);

export default router;

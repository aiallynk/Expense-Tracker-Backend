import express from 'express';

import { EmployeeApprovalProfileController } from '../controllers/employeeApprovalProfile.controller';
import { authMiddleware as protect } from '../middleware/auth.middleware';
import { requireRole as authorize } from '../middleware/role.middleware';
import { UserRole } from '../utils/enums';

const router = express.Router();

// Company admin can view/edit employee approval profiles (AI output + manual overrides)
router.get('/company', protect, authorize(UserRole.COMPANY_ADMIN), EmployeeApprovalProfileController.listCompanyActive);
router.get('/', protect, authorize(UserRole.COMPANY_ADMIN), EmployeeApprovalProfileController.get);
router.put('/', protect, authorize(UserRole.COMPANY_ADMIN), EmployeeApprovalProfileController.setManualChain);
router.delete('/', protect, authorize(UserRole.COMPANY_ADMIN), EmployeeApprovalProfileController.clear);

export default router;



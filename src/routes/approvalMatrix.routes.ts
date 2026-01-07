import express from 'express';

import { ApprovalMatrixController } from '../controllers/approvalMatrix.controller';
import { authMiddleware as protect } from '../middleware/auth.middleware';
import { requireRole as authorize } from '../middleware/role.middleware';
import { UserRole } from '../utils/enums';

const router = express.Router();

// Role Management (Company Admin Only)
router.post('/roles', protect, authorize(UserRole.COMPANY_ADMIN), ApprovalMatrixController.createRole);
router.get('/roles', protect, authorize(UserRole.COMPANY_ADMIN, UserRole.EMPLOYEE, UserRole.MANAGER, UserRole.BUSINESS_HEAD), ApprovalMatrixController.getRoles);
router.put('/roles/:id', protect, authorize(UserRole.COMPANY_ADMIN), ApprovalMatrixController.updateRole);
router.delete('/roles/:id', protect, authorize(UserRole.COMPANY_ADMIN), ApprovalMatrixController.deleteRole);

// Matrix Management (Company Admin Only)
router.post('/', protect, authorize(UserRole.COMPANY_ADMIN), ApprovalMatrixController.createMatrix);
router.get('/', protect, authorize(UserRole.COMPANY_ADMIN), ApprovalMatrixController.getMatrix);

// Approval Actions (Approvers)
router.get('/pending', protect, ApprovalMatrixController.getPendingApprovals);
router.get('/history', protect, ApprovalMatrixController.getApprovalHistory);
router.post('/instances/:instanceId/approve', protect, ApprovalMatrixController.approveRequest);
router.post('/instances/:instanceId/reject', protect, ApprovalMatrixController.rejectRequest);
router.post('/instances/:instanceId/request-changes', protect, ApprovalMatrixController.requestChanges);

export default router;

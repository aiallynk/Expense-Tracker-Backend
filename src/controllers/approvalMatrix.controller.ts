import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ApprovalMatrix } from '../models/ApprovalMatrix';
import { CostCentre } from '../models/CostCentre';
import { Project } from '../models/Project';
import { Role } from '../models/Role';
import { User } from '../models/User';
import { ApprovalService } from '../services/ApprovalService';

export class ApprovalMatrixController {

    // ================= ROLE MANAGEMENT =================

    static createRole = asyncHandler(async (req: AuthRequest, res: Response) => {
        const { name, description } = req.body;

        // Resolve companyId
        let companyIdString: string | undefined = req.user?.companyId;
        if (!companyIdString) {
            const user = await User.findById(req.user!.id).select('companyId');
            companyIdString = user?.companyId?.toString();
        }

        if (!companyIdString) throw new Error('Company ID not found for user');

        const companyId = new mongoose.Types.ObjectId(companyIdString);

        // Explicitly set type to CUSTOM
        const role = await Role.create({
            companyId,
            name,
            description,
            type: 'CUSTOM'
        });

        res.status(201).json({ success: true, data: role });
    });

    static updateRole = asyncHandler(async (req: AuthRequest, res: Response) => {
        const { id } = req.params;
        const { name, description } = req.body;

        const role = await Role.findById(id);
        if (!role) throw new Error('Role not found');

        // Prevent editing SYSTEM roles
        if (role.type === 'SYSTEM') {
            throw new Error('System roles cannot be modified');
        }

        if (name) role.name = name;
        if (description !== undefined) role.description = description;

        await role.save();

        res.json({ success: true, data: role });
    });

    static deleteRole = asyncHandler(async (req: AuthRequest, res: Response) => {
        const { id } = req.params;

        const role = await Role.findById(id);
        if (!role) throw new Error('Role not found');

        if (role.type === 'SYSTEM') {
            throw new Error('System roles cannot be deleted');
        }

        // Check if used in any Active Approval Matrix
        const matrixInUse = await ApprovalMatrix.findOne({
            companyId: role.companyId,
            isActive: true,
            'levels.approverRoleIds': role._id
        });

        if (matrixInUse) {
            throw new Error('Cannot delete role: It is currently used in an active Approval Matrix');
        }

        await Role.findByIdAndDelete(id);

        res.json({ success: true, message: 'Role deleted successfully' });
    });

    static getRoles = asyncHandler(async (req: AuthRequest, res: Response) => {
        let companyIdString: string | undefined = req.user?.companyId;
        if (!companyIdString) {
            const user = await User.findById(req.user!.id).select('companyId');
            companyIdString = user?.companyId?.toString();
        }
        if (!companyIdString) throw new Error('Company ID not found');

        const companyId = new mongoose.Types.ObjectId(companyIdString);

        // Sort by type (SYSTEM first if Z-A or check value? 'SYSTEM' > 'CUSTOM' alphabetically? No. 'S' > 'C'. So -1 might put SYSTEM first? Check later. Usually we want separate lists in UI anyway)
        const roles = await Role.find({ companyId, isActive: true }).sort({ type: -1, name: 1 });
        res.json({ success: true, data: roles });
    });

    // ================= MATRIX MANAGEMENT =================

    static createMatrix = asyncHandler(async (req: AuthRequest, res: Response) => {
        let companyIdString: string | undefined = req.user?.companyId;
        if (!companyIdString) {
            const user = await User.findById(req.user!.id).select('companyId');
            companyIdString = user?.companyId?.toString();
        }
        if (!companyIdString) throw new Error('Company ID not found');

        const companyId = new mongoose.Types.ObjectId(companyIdString);

        const { name, levels } = req.body;

        // Set all other matrices to inactive
        await ApprovalMatrix.updateMany({ companyId }, { isActive: false });

        const matrix = await ApprovalMatrix.create({
            companyId,
            name,
            levels,
            isActive: true
        });

        res.status(201).json({ success: true, data: matrix });
    });

    static getMatrix = asyncHandler(async (req: AuthRequest, res: Response) => {
        let companyIdString: string | undefined = req.user?.companyId;
        if (!companyIdString) {
            const user = await User.findById(req.user!.id).select('companyId');
            companyIdString = user?.companyId?.toString();
        }
        if (!companyIdString) throw new Error('Company ID not found');

        const companyId = new mongoose.Types.ObjectId(companyIdString);

        const matrix = await ApprovalMatrix.findOne({ companyId, isActive: true });
        res.json({ success: true, data: matrix });
    });

    // ================= ACTIONS =================
    // Single resolution for "current user id" so pending, history, and approve/reject/request-changes all use the same value.
    private static getCurrentUserId(req: AuthRequest): string | null {
        const raw = req.user?.id ?? (req.user as any)?._id;
        return raw != null ? String(raw) : null;
    }

    static approveRequest = asyncHandler(async (req: AuthRequest, res: Response) => {
        const instanceId = Array.isArray(req.params.instanceId) ? req.params.instanceId[0] : req.params.instanceId;
        const { comment } = req.body;
        const userId = ApprovalMatrixController.getCurrentUserId(req);
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(401).json({ success: false, message: 'Invalid user context for approval action' });
        }

        const result = await ApprovalService.processAction(instanceId, userId, 'APPROVE', comment);
        return res.json({ success: true, data: result });
    });

    static rejectRequest = asyncHandler(async (req: AuthRequest, res: Response) => {
        const instanceId = Array.isArray(req.params.instanceId) ? req.params.instanceId[0] : req.params.instanceId;
        const { comment } = req.body;
        const userId = ApprovalMatrixController.getCurrentUserId(req);
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(401).json({ success: false, message: 'Invalid user context for approval action' });
        }

        const result = await ApprovalService.processAction(instanceId, userId, 'REJECT', comment);
        return res.json({ success: true, data: result });
    });

    static requestChanges = asyncHandler(async (req: AuthRequest, res: Response) => {
        const instanceId = Array.isArray(req.params.instanceId) ? req.params.instanceId[0] : req.params.instanceId;
        const { comment } = req.body;
        const userId = ApprovalMatrixController.getCurrentUserId(req);
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(401).json({ success: false, message: 'Invalid user context for approval action' });
        }

        const result = await ApprovalService.processAction(instanceId, userId, 'REQUEST_CHANGES', comment);
        return res.json({ success: true, data: result });
    });

    static getPendingApprovals = asyncHandler(async (req: AuthRequest, res: Response) => {
        const userId = ApprovalMatrixController.getCurrentUserId(req);
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(401).json({ success: false, message: 'Invalid user context for pending approvals' });
        }
        const { page, limit, startDate, endDate } = req.query;

        const options: any = {};
        if (page) options.page = parseInt(page as string);
        if (limit) options.limit = parseInt(limit as string);
        if (startDate) options.startDate = startDate as string;
        if (endDate) options.endDate = endDate as string;

        const result = await ApprovalService.getPendingApprovalsForUser(userId, options);
        return res.json({ success: true, data: result.data, total: result.total });
    });

    // ================= APPROVAL HISTORY =================

    static getApprovalHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
        const userId = ApprovalMatrixController.getCurrentUserId(req);
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(401).json({ success: false, message: 'Invalid user context for approval history' });
        }
        const { actionType, employee, project, costCentre, startDate, endDate, page = 1, limit = 20 } = req.query;

        // Only allow APPROVED, REJECTED, CHANGES_REQUESTED for history; reject invalid actionType
        const allowedActionTypes = ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'];
        if (actionType && !allowedActionTypes.includes(String(actionType).toUpperCase())) {
            return res.status(400).json({ success: false, message: 'actionType must be one of: APPROVED, REJECTED, CHANGES_REQUESTED' });
        }

        const filters: any = {
            actedBy: new mongoose.Types.ObjectId(userId),
        };

        if (actionType) {
            filters.actionType = String(actionType).toUpperCase();
        }

        if (employee) {
            // This will be handled in the service with joins
        }

        if (project) {
            const projectStr = project as string;
            if (mongoose.Types.ObjectId.isValid(projectStr) && projectStr.length === 24) {
                filters.projectId = new mongoose.Types.ObjectId(projectStr);
            } else {
                const companyId = (req.user?.companyId as string) || (await User.findById(userId).select('companyId').then((u) => u?.companyId?.toString()));
                const proj = companyId
                    ? await Project.findOne({ name: projectStr, companyId: new mongoose.Types.ObjectId(companyId) }).select('_id').lean()
                    : await Project.findOne({ name: projectStr }).select('_id').lean();
                if (proj?._id) filters.projectId = proj._id;
            }
        }

        if (costCentre) {
            const ccStr = costCentre as string;
            if (mongoose.Types.ObjectId.isValid(ccStr) && ccStr.length === 24) {
                filters.costCentreId = new mongoose.Types.ObjectId(ccStr);
            } else {
                const companyId = (req.user?.companyId as string) || (await User.findById(userId).select('companyId').then((u) => u?.companyId?.toString()));
                const cc = companyId
                    ? await CostCentre.findOne({ name: ccStr, companyId: new mongoose.Types.ObjectId(companyId) }).select('_id').lean()
                    : await CostCentre.findOne({ name: ccStr }).select('_id').lean();
                if (cc?._id) filters.costCentreId = cc._id;
            }
        }

        if (startDate && endDate) {
            // For single date filtering, use the same date for both start and end
            filters.dateRange = {
                $gte: new Date(startDate as string),
                $lte: new Date(endDate as string)
            };
        }

        const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
        const limitNum = Math.min(1000, Math.max(1, parseInt(String(limit), 10) || 20));
        const history = await ApprovalService.getApprovalHistory(filters, employee as string, {
            page: pageNum,
            limit: limitNum,
        });
        // History endpoint: actions by current user (APPROVED/REJECTED/CHANGES_REQUESTED). Never default actionType to PENDING.
        // Response shape: { success: true, data: { data: array, pagination: { page, limit, total, pages } } }
        return res.json({ success: true, data: history });
    });

}

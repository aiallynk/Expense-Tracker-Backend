import { Response } from 'express';
import mongoose from 'mongoose';

import { AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { ApprovalMatrix } from '../models/ApprovalMatrix';
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

    static approveRequest = asyncHandler(async (req: AuthRequest, res: Response) => {
        const { instanceId } = req.params;
        const { comment } = req.body;
        const userId = req.user!.id;

        const result = await ApprovalService.processAction(instanceId, userId, 'APPROVE', comment);
        res.json({ success: true, data: result });
    });

    static rejectRequest = asyncHandler(async (req: AuthRequest, res: Response) => {
        const { instanceId } = req.params;
        const { comment } = req.body;
        const userId = req.user!.id;

        const result = await ApprovalService.processAction(instanceId, userId, 'REJECT', comment);
        res.json({ success: true, data: result });
    });

    static requestChanges = asyncHandler(async (req: AuthRequest, res: Response) => {
        const { instanceId } = req.params;
        const { comment } = req.body;
        const userId = req.user!.id;

        const result = await ApprovalService.processAction(instanceId, userId, 'REQUEST_CHANGES', comment);
        res.json({ success: true, data: result });
    });

    static getPendingApprovals = asyncHandler(async (req: AuthRequest, res: Response) => {
        const userId = req.user!.id;
        const { page, limit, startDate, endDate } = req.query;

        const options: any = {};
        if (page) options.page = parseInt(page as string);
        if (limit) options.limit = parseInt(limit as string);
        if (startDate) options.startDate = startDate as string;
        if (endDate) options.endDate = endDate as string;

        const result = await ApprovalService.getPendingApprovalsForUser(userId, options);
        res.json({ success: true, data: result.data, total: result.total });
    });

    // ================= APPROVAL HISTORY =================

    static getApprovalHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
        const userId = req.user!.id;
        const { actionType, employee, project, costCentre, startDate, endDate, page = 1, limit = 20 } = req.query;

        const filters: any = {
            actedBy: new mongoose.Types.ObjectId(userId),
        };

        if (actionType) {
            filters.actionType = actionType;
        }

        if (employee) {
            // This will be handled in the service with joins
        }

        if (project) {
            filters.projectId = new mongoose.Types.ObjectId(project as string);
        }

        if (costCentre) {
            filters.costCentreId = new mongoose.Types.ObjectId(costCentre as string);
        }

        if (startDate && endDate) {
            // For single date filtering, use the same date for both start and end
            filters.dateRange = {
                $gte: new Date(startDate as string),
                $lte: new Date(endDate as string)
            };
        }

        const history = await ApprovalService.getApprovalHistory(filters, employee as string, {
            page: parseInt(page as string),
            limit: parseInt(limit as string),
        });

        res.json({ success: true, data: history });
    });

}

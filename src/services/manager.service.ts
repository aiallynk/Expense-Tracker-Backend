import mongoose from 'mongoose';

import { Expense } from '../models/Expense';
import { ExpenseReport, IExpenseReport } from '../models/ExpenseReport';
import { NotificationType } from '../models/Notification';
import { Team } from '../models/Team';
import { User, IUser } from '../models/User';
import { emitManagerReportUpdate } from '../socket/realtimeEvents';
import { AuditAction , ExpenseReportStatus, UserRole, ExpenseStatus } from '../utils/enums';
import { getPresignedDownloadUrl } from '../utils/s3';

import { AuditService } from './audit.service';
import { NotificationDataService } from './notificationData.service';

import { logger } from '@/config/logger';

export class ManagerService {
  /**
   * Helper function to check if a user is in a manager's team
   * Checks both:
   * 1. Direct reports (user.managerId matches managerId)
   * 2. Team members (user is in a team where managerId is the team leader)
   */
  static async isUserInManagerTeam(userId: string, managerId: string): Promise<boolean> {
    // Check direct manager relationship
    const user = await User.findById(userId).select('managerId').exec();
    if (user && user.managerId?.toString() === managerId) {
      return true;
    }

    // Check team membership
    const teams = await Team.find({
      managerId: new mongoose.Types.ObjectId(managerId),
      status: 'ACTIVE',
      'members.userId': new mongoose.Types.ObjectId(userId)
    }).limit(1).exec();

    return teams.length > 0;
  }

  /**
   * Get all team members (employees) under a manager
   * Includes both:
   * 1. Direct reports (employees with managerId matching this manager)
   * 2. Team members (employees in teams where this manager is the team leader)
   */
  static async getTeamMembers(managerId: string): Promise<IUser[]> {
    // Step 1: Get direct team members
    const directTeamMembers = await User.find({ 
      managerId: new mongoose.Types.ObjectId(managerId),
      status: 'ACTIVE',
      role: UserRole.EMPLOYEE
    })
      .select('-passwordHash')
      .populate('departmentId', 'name code')
      .sort({ name: 1 })
      .exec();

    // Step 2: Get team members from teams where this manager is the team leader
    const teams = await Team.find({
      managerId: new mongoose.Types.ObjectId(managerId),
      status: 'ACTIVE'
    }).select('members').exec();
    
    // Extract all userIds from team members
    const teamMemberIds: mongoose.Types.ObjectId[] = [];
    teams.forEach(team => {
      if (team.members && Array.isArray(team.members)) {
        team.members.forEach((member: any) => {
          if (member.userId) {
            teamMemberIds.push(member.userId);
          }
        });
      }
    });

    // Step 3: Get User records for team members
    const teamMemberUsers = teamMemberIds.length > 0
      ? await User.find({
          _id: { $in: teamMemberIds },
          status: 'ACTIVE',
          role: UserRole.EMPLOYEE
        })
          .select('-passwordHash')
          .populate('departmentId', 'name code')
          .sort({ name: 1 })
          .exec()
      : [];

    // Step 4: Combine and remove duplicates
    const allMembersMap = new Map<string, IUser>();
    
    directTeamMembers.forEach(member => {
      allMembersMap.set((member._id as any).toString(), member);
    });
    
    teamMemberUsers.forEach(member => {
      if (!allMembersMap.has((member._id as any).toString())) {
        allMembersMap.set((member._id as any).toString(), member);
      }
    });

    return Array.from(allMembersMap.values()).sort((a, b) => {
      const nameA = a.name || '';
      const nameB = b.name || '';
      return nameA.localeCompare(nameB);
    });
  }

  /**
   * Get team reports - reports submitted by team members
   * Includes both:
   * 1. Direct reports (employees with managerId matching this manager)
   * 2. Team members (employees in teams where this manager is the team leader)
   */
  static async getTeamReports(
    managerId: string,
    filters: {
      status?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    }
  ): Promise<{ reports: any[]; total: number }> {
    // Step 1: Get direct team members (employees with managerId matching this manager)
    const directTeamMembers = await User.find({ 
      managerId: new mongoose.Types.ObjectId(managerId),
      status: 'ACTIVE'
    }).select('_id').exec();
    
    const directTeamMemberIds = directTeamMembers.map(m => m._id);

    // Step 2: Get team members from teams where this manager is the team leader
    const teams = await Team.find({
      managerId: new mongoose.Types.ObjectId(managerId),
      status: 'ACTIVE'
    }).select('members').exec();
    
    // Extract all userIds from team members
    const teamMemberIds: mongoose.Types.ObjectId[] = [];
    teams.forEach(team => {
      if (team.members && Array.isArray(team.members)) {
        team.members.forEach((member: any) => {
          if (member.userId) {
            teamMemberIds.push(member.userId);
          }
        });
      }
    });

    // Step 3: Combine both lists and remove duplicates
    const allTeamMemberIds = [
      ...directTeamMemberIds,
      ...teamMemberIds
    ];
    
    // Remove duplicates using Set
    const uniqueTeamMemberIds = Array.from(
      new Set(allTeamMemberIds.map((id: any) => (id as any).toString()))
    ).map(id => new mongoose.Types.ObjectId(id));

    if (uniqueTeamMemberIds.length === 0) {
      logger.debug({ managerId }, 'No team members found for manager');
      return { reports: [], total: 0 };
    }

    logger.debug({ 
      managerId, 
      directCount: directTeamMemberIds.length,
      teamMembersCount: teamMemberIds.length,
      totalUnique: uniqueTeamMemberIds.length
    }, 'Team member IDs found');

    // Build query
    const query: any = {
      userId: { $in: uniqueTeamMemberIds }
    };

    if (filters.status && filters.status !== 'all') {
      query.status = filters.status;
    }

    if (filters.search) {
      query.$or = [
        { name: { $regex: filters.search, $options: 'i' } },
        { notes: { $regex: filters.search, $options: 'i' } }
      ];
    }

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 20;
    const skip = (page - 1) * pageSize;

    const [reports, total] = await Promise.all([
      ExpenseReport.find(query)
        .populate('userId', 'name email managerId')
        .populate('projectId', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .exec(),
      ExpenseReport.countDocuments(query).exec()
    ]);

    logger.debug({ 
      managerId, 
      reportsFound: reports.length, 
      total 
    }, 'Team reports query result');

    return { reports, total };
  }

  /**
   * Get team expenses - expenses from team members' reports
   * Includes both direct reports and team members
   */
  static async getTeamExpenses(
    managerId: string,
    filters: {
      status?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    }
  ): Promise<{ expenses: any[]; total: number }> {
    // Step 1: Get direct team members
    const directTeamMembers = await User.find({ 
      managerId: new mongoose.Types.ObjectId(managerId),
      status: 'ACTIVE'
    }).select('_id').exec();
    
    const directTeamMemberIds = directTeamMembers.map(m => m._id);

    // Step 2: Get team members from teams where this manager is the team leader
    const teams = await Team.find({
      managerId: new mongoose.Types.ObjectId(managerId),
      status: 'ACTIVE'
    }).select('members').exec();
    
    // Extract all userIds from team members
    const teamMemberIds: mongoose.Types.ObjectId[] = [];
    teams.forEach(team => {
      if (team.members && Array.isArray(team.members)) {
        team.members.forEach((member: any) => {
          if (member.userId) {
            teamMemberIds.push(member.userId);
          }
        });
      }
    });

    // Step 3: Combine both lists and remove duplicates
    const allTeamMemberIds = [
      ...directTeamMemberIds,
      ...teamMemberIds
    ];
    
    const uniqueTeamMemberIds = Array.from(
      new Set(allTeamMemberIds.map((id: any) => (id as any).toString()))
    ).map(id => new mongoose.Types.ObjectId(id));

    if (uniqueTeamMemberIds.length === 0) {
      return { expenses: [], total: 0 };
    }

    // Get reports from all team members (direct and via teams)
    const teamReports = await ExpenseReport.find({
      userId: { $in: uniqueTeamMemberIds }
    }).select('_id').exec();
    
    const reportIds = teamReports.map(r => r._id);

    if (reportIds.length === 0) {
      return { expenses: [], total: 0 };
    }

    // Build query
    const query: any = {
      reportId: { $in: reportIds }
    };

    if (filters.status && filters.status !== 'all') {
      query.status = filters.status;
    }

    if (filters.search) {
      query.$or = [
        { description: { $regex: filters.search, $options: 'i' } },
        { merchant: { $regex: filters.search, $options: 'i' } },
        { category: { $regex: filters.search, $options: 'i' } }
      ];
    }

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 20;
    const skip = (page - 1) * pageSize;

    const [expenses, total] = await Promise.all([
      Expense.find(query)
        .populate('reportId', 'name fromDate toDate')
        .populate({
          path: 'reportId',
          populate: {
            path: 'userId',
            select: 'name email'
          }
        })
        .sort({ date: -1 })
        .skip(skip)
        .limit(pageSize)
        .exec(),
      Expense.countDocuments(query).exec()
    ]);

    return { expenses, total };
  }

  /**
   * Manager approves a report
   */
  static async approveReport(
    reportId: string,
    managerId: string,
    comment?: string
  ): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email managerId')
      .exec();

    if (!report) {
      const error: any = new Error('Report not found');
      error.statusCode = 404;
      error.code = 'REPORT_NOT_FOUND';
      throw error;
    }

    // Verify the report belongs to a team member (direct or via teams)
    const reportUserId = (report.userId as any)?._id?.toString() || (report.userId as any)?.toString();
    if (!reportUserId) {
      const error: any = new Error('Invalid report user');
      error.statusCode = 400;
      error.code = 'INVALID_REPORT';
      throw error;
    }

    const isInTeam = await this.isUserInManagerTeam(reportUserId, managerId);
    if (!isInTeam) {
      const error: any = new Error('You can only approve reports from your team members');
      error.statusCode = 403;
      error.code = 'ACCESS_DENIED';
      throw error;
    }

    // Verify report is in SUBMITTED status
    if (report.status !== ExpenseReportStatus.SUBMITTED) {
      const error: any = new Error(`Cannot approve report with status: ${report.status}`);
      error.statusCode = 400;
      error.code = 'INVALID_STATUS';
      throw error;
    }

    // Check for pending or rejected expenses
    const pendingExpenses = await Expense.countDocuments({
      reportId: new mongoose.Types.ObjectId(reportId),
      status: ExpenseStatus.PENDING
    });

    if (pendingExpenses > 0) {
      const error: any = new Error(`Cannot approve report: ${pendingExpenses} expense(s) are pending changes. Please wait for employee to update them or approve/reject individually.`);
      error.statusCode = 400;
      error.code = 'PENDING_EXPENSES';
      throw error;
    }

    const rejectedExpenses = await Expense.countDocuments({
      reportId: new mongoose.Types.ObjectId(reportId),
      status: ExpenseStatus.REJECTED
    });

    if (rejectedExpenses > 0) {
      const error: any = new Error(`Cannot approve report: ${rejectedExpenses} expense(s) are rejected. Please wait for employee to update or delete them.`);
      error.statusCode = 400;
      error.code = 'REJECTED_EXPENSES';
      throw error;
    }

    // Update approvers array
    const approverIndex = report.approvers.findIndex(
      (a: any) => a.userId.toString() === managerId && a.level === 1
    );

    const approverData = {
      level: 1,
      userId: new mongoose.Types.ObjectId(managerId),
      role: 'MANAGER',
      decidedAt: new Date(),
      action: 'approve',
      comment: comment || undefined
    };

    if (approverIndex >= 0) {
      report.approvers[approverIndex] = approverData;
    } else {
      report.approvers.push(approverData);
    }

    // Update report status
    report.status = ExpenseReportStatus.MANAGER_APPROVED;
    report.approvedAt = new Date();
    report.updatedBy = new mongoose.Types.ObjectId(managerId);

    await report.save();

    // Approve all expenses in the report and emit real-time events
    try {
      const expenses = await Expense.find({ reportId: new mongoose.Types.ObjectId(reportId) }).exec();
      
      // Update all expenses to APPROVED
      await Expense.updateMany(
        { reportId: new mongoose.Types.ObjectId(reportId) },
        { 
          $set: { 
            status: ExpenseStatus.APPROVED 
          } 
        }
      );
      logger.info(`Approved all expenses for report ${reportId}`);

      // Emit real-time events for each approved expense
      try {
        const { emitExpenseApprovedToEmployee } = await import('../socket/realtimeEvents');
        for (const expense of expenses) {
          const expenseObj = expense.toObject();
          emitExpenseApprovedToEmployee(reportUserId, expenseObj);
        }
      } catch (error) {
        logger.error({ error }, 'Error emitting expense approval events');
      }
    } catch (error) {
      logger.error({ error, reportId }, 'Error approving expenses for report');
      // Don't fail report approval if expense update fails
    }

    // Audit log
    await AuditService.log(
      managerId,
      'ExpenseReport',
      reportId,
      AuditAction.STATUS_CHANGE
    );

    // Send notification to employee
    try {
      const reportUser = report.userId as any;
      if (reportUser) {
        const userId = reportUser._id?.toString() || reportUser.toString();
        await NotificationDataService.createNotification({
          userId,
          type: NotificationType.REPORT_APPROVED,
          title: 'Report Approved',
          description: `Your report "${report.name}" has been approved by your manager.`,
          link: `/reports/${reportId}`,
          companyId: reportUser.companyId?.toString()
        });
      }
    } catch (error) {
      logger.error({ error }, 'Error sending notification');
    }

    // Emit real-time event
    const populatedReport = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email')
      .populate('projectId', 'name code')
      .exec();

    if (populatedReport) {
      emitManagerReportUpdate(managerId, 'approved', populatedReport);
    }

    return populatedReport!;
  }

  /**
   * Manager rejects a report
   */
  static async rejectReport(
    reportId: string,
    managerId: string,
    comment?: string
  ): Promise<IExpenseReport> {
    const report = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email managerId')
      .exec();

    if (!report) {
      const error: any = new Error('Report not found');
      error.statusCode = 404;
      error.code = 'REPORT_NOT_FOUND';
      throw error;
    }

    // Verify the report belongs to a team member (direct or via teams)
    const reportUserId = (report.userId as any)?._id?.toString() || (report.userId as any)?.toString();
    if (!reportUserId) {
      const error: any = new Error('Invalid report user');
      error.statusCode = 400;
      error.code = 'INVALID_REPORT';
      throw error;
    }

    const isInTeam = await this.isUserInManagerTeam(reportUserId, managerId);
    if (!isInTeam) {
      const error: any = new Error('You can only reject reports from your team members');
      error.statusCode = 403;
      error.code = 'ACCESS_DENIED';
      throw error;
    }

    // Verify report is in SUBMITTED status
    if (report.status !== ExpenseReportStatus.SUBMITTED) {
      const error: any = new Error(`Cannot reject report with status: ${report.status}`);
      error.statusCode = 400;
      error.code = 'INVALID_STATUS';
      throw error;
    }

    // Update approvers array
    const approverIndex = report.approvers.findIndex(
      (a: any) => a.userId.toString() === managerId && a.level === 1
    );

    const approverData = {
      level: 1,
      userId: new mongoose.Types.ObjectId(managerId),
      role: 'MANAGER',
      decidedAt: new Date(),
      action: 'reject',
      comment: comment || undefined
    };

    if (approverIndex >= 0) {
      report.approvers[approverIndex] = approverData;
    } else {
      report.approvers.push(approverData);
    }

    // Update report status
    report.status = ExpenseReportStatus.REJECTED;
    report.rejectedAt = new Date();
    report.updatedBy = new mongoose.Types.ObjectId(managerId);

    await report.save();

    // Audit log
    await AuditService.log(
      managerId,
      'ExpenseReport',
      reportId,
      AuditAction.STATUS_CHANGE
    );

    // Send notification to employee
    try {
      const reportUser = report.userId as any;
      if (reportUser) {
        const userId = reportUser._id?.toString() || reportUser.toString();
        await NotificationDataService.createNotification({
          userId,
          type: NotificationType.REPORT_REJECTED,
          title: 'Report Rejected',
          description: `Your report "${report.name}" has been rejected by your manager.${comment ? ` Reason: ${comment}` : ''}`,
          link: `/reports/${reportId}`,
          companyId: reportUser.companyId?.toString()
        });
      }
    } catch (error) {
      logger.error({ error }, 'Error sending notification');
    }

    // Emit real-time event
    const populatedReport = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email')
      .populate('projectId', 'name code')
      .exec();

    if (populatedReport) {
      emitManagerReportUpdate(managerId, 'rejected', populatedReport);
    }

    return populatedReport!;
  }

  /**
   * Get report details for manager review
   */
  static async getReportForReview(
    reportId: string,
    managerId: string
  ): Promise<any> {
    const report = await ExpenseReport.findById(reportId)
      .populate('userId', 'name email managerId')
      .populate('projectId', 'name code')
      .exec();

    if (!report) {
      const error: any = new Error('Report not found');
      error.statusCode = 404;
      error.code = 'REPORT_NOT_FOUND';
      throw error;
    }

    // Verify the report belongs to a team member (direct or via teams)
    const reportUserId = (report.userId as any)?._id?.toString() || (report.userId as any)?.toString();
    if (!reportUserId) {
      const error: any = new Error('Invalid report user');
      error.statusCode = 400;
      error.code = 'INVALID_REPORT';
      throw error;
    }

    const isInTeam = await this.isUserInManagerTeam(reportUserId, managerId);
    if (!isInTeam) {
      const error: any = new Error('You can only view reports from your team members');
      error.statusCode = 403;
      error.code = 'ACCESS_DENIED';
      throw error;
    }

    // Get expenses for this report with receipts
    const expenses = await Expense.find({ reportId: report._id })
      .populate('categoryId', 'name')
      .populate('receiptIds')
      .sort({ expenseDate: -1 })
      .exec();

    // Generate signed URLs for receipts
    const expensesWithSignedUrls = await Promise.all(
      expenses.map(async (exp) => {
        const expObj = exp.toObject();
        if (expObj.receiptIds && Array.isArray(expObj.receiptIds)) {
          expObj.receiptIds = await Promise.all(
            expObj.receiptIds.map(async (receipt: any) => {
              try {
                if (receipt.storageKey) {
                  const signedUrl = await getPresignedDownloadUrl('receipts', receipt.storageKey, 3600 * 24); // 24 hours
                  return { ...receipt, signedUrl };
                }
                return receipt;
              } catch (error) {
                logger.error({ receiptId: receipt._id, error }, 'Error generating signed URL for receipt');
                return receipt;
              }
            })
          );
        }
        return expObj;
      })
    );

    return {
      ...report.toObject(),
      expenses: expensesWithSignedUrls
    };
  }

  /**
   * Manager approves an individual expense
   */
  static async approveExpense(
    expenseId: string,
    managerId: string,
    comment?: string
  ): Promise<any> {
    const expense = await Expense.findById(expenseId)
      .populate('reportId')
      .exec();

    if (!expense) {
      const error: any = new Error('Expense not found');
      error.statusCode = 404;
      error.code = 'EXPENSE_NOT_FOUND';
      throw error;
    }

    const report = expense.reportId as any;
    
    // Verify the expense belongs to a team member (direct or via teams)
    const reportUserId = report.userId?.toString() || report.userId?._id?.toString();
    if (!reportUserId) {
      const error: any = new Error('Invalid report user');
      error.statusCode = 400;
      error.code = 'INVALID_REPORT';
      throw error;
    }

    const isInTeam = await this.isUserInManagerTeam(reportUserId, managerId);
    if (!isInTeam) {
      const error: any = new Error('You can only approve expenses from your team members');
      error.statusCode = 403;
      error.code = 'ACCESS_DENIED';
      throw error;
    }

    // Update expense status and manager feedback
    expense.status = ExpenseStatus.APPROVED;
    expense.managerAction = 'approve';
    expense.managerActionAt = new Date();
    expense.managerComment = comment || undefined;
    await expense.save();

    // Audit log
    await AuditService.log(
      managerId,
      'Expense',
      expenseId,
      AuditAction.STATUS_CHANGE,
      { status: ExpenseStatus.APPROVED, comment }
    );

    // Emit real-time event to manager
    emitManagerReportUpdate(managerId, 'EXPENSE_APPROVED', report.toObject());

    // Emit real-time event to employee (expense owner)
    try {
      const { emitExpenseApprovedToEmployee } = await import('../socket/realtimeEvents');
      const expenseObj = expense.toObject();
      emitExpenseApprovedToEmployee(reportUserId, expenseObj);
    } catch (error) {
      logger.error({ error }, 'Error emitting expense approved to employee');
    }

    return expense;
  }

  /**
   * Manager rejects an individual expense
   */
  static async rejectExpense(
    expenseId: string,
    managerId: string,
    comment: string
  ): Promise<any> {
    if (!comment || !comment.trim()) {
      const error: any = new Error('Comment is required when rejecting an expense');
      error.statusCode = 400;
      error.code = 'COMMENT_REQUIRED';
      throw error;
    }

    const expense = await Expense.findById(expenseId)
      .populate('reportId')
      .exec();

    if (!expense) {
      const error: any = new Error('Expense not found');
      error.statusCode = 404;
      error.code = 'EXPENSE_NOT_FOUND';
      throw error;
    }

    const report = expense.reportId as any;
    
    // Verify the expense belongs to a team member (direct or via teams)
    const reportUserId = report.userId?.toString() || report.userId?._id?.toString();
    if (!reportUserId) {
      const error: any = new Error('Invalid report user');
      error.statusCode = 400;
      error.code = 'INVALID_REPORT';
      throw error;
    }

    const isInTeam = await this.isUserInManagerTeam(reportUserId, managerId);
    if (!isInTeam) {
      const error: any = new Error('You can only reject expenses from your team members');
      error.statusCode = 403;
      error.code = 'ACCESS_DENIED';
      throw error;
    }

    // Update expense status and manager feedback
    expense.status = ExpenseStatus.REJECTED;
    expense.managerAction = 'reject';
    expense.managerActionAt = new Date();
    expense.managerComment = comment;
    await expense.save();

    // Update report status to CHANGES_REQUESTED so employee knows to make changes
    if (report.status === ExpenseReportStatus.SUBMITTED) {
      await ExpenseReport.findByIdAndUpdate(report._id, {
        status: ExpenseReportStatus.CHANGES_REQUESTED
      });
    }

    // Audit log
    await AuditService.log(
      managerId,
      'Expense',
      expenseId,
      AuditAction.STATUS_CHANGE,
      { status: ExpenseStatus.REJECTED, comment }
    );

    // Emit real-time event to manager
    const updatedReport = await ExpenseReport.findById(report._id).populate('userId', 'name email').exec();
    emitManagerReportUpdate(managerId, 'EXPENSE_REJECTED', updatedReport?.toObject() || report.toObject());

    // Emit real-time event to employee (expense owner)
    try {
      const { emitExpenseRejectedToEmployee } = await import('../socket/realtimeEvents');
      const expenseObj = expense.toObject();
      emitExpenseRejectedToEmployee(reportUserId, expenseObj);
    } catch (error) {
      logger.error({ error }, 'Error emitting expense rejected to employee');
    }

    return expense;
  }

  /**
   * Manager requests changes for an individual expense
   */
  static async requestExpenseChanges(
    expenseId: string,
    managerId: string,
    comment: string
  ): Promise<any> {
    if (!comment || !comment.trim()) {
      const error: any = new Error('Comment is required when requesting expense changes');
      error.statusCode = 400;
      error.code = 'COMMENT_REQUIRED';
      throw error;
    }

    const expense = await Expense.findById(expenseId)
      .populate('reportId')
      .exec();

    if (!expense) {
      const error: any = new Error('Expense not found');
      error.statusCode = 404;
      error.code = 'EXPENSE_NOT_FOUND';
      throw error;
    }

    const report = expense.reportId as any;
    
    // Verify the expense belongs to a team member (direct or via teams)
    const reportUserId = report.userId?.toString() || report.userId?._id?.toString();
    if (!reportUserId) {
      const error: any = new Error('Invalid report user');
      error.statusCode = 400;
      error.code = 'INVALID_REPORT';
      throw error;
    }

    const isInTeam = await this.isUserInManagerTeam(reportUserId, managerId);
    if (!isInTeam) {
      const error: any = new Error('You can only request changes for expenses from your team members');
      error.statusCode = 403;
      error.code = 'ACCESS_DENIED';
      throw error;
    }

    // For request changes, we set status to PENDING to indicate changes are needed
    expense.status = ExpenseStatus.PENDING;
    expense.managerAction = 'request_changes';
    expense.managerActionAt = new Date();
    expense.managerComment = comment;
    await expense.save();

    // Update report status to CHANGES_REQUESTED so employee knows to make changes
    if (report.status === ExpenseReportStatus.SUBMITTED) {
      await ExpenseReport.findByIdAndUpdate(report._id, {
        status: ExpenseReportStatus.CHANGES_REQUESTED
      });
    }
    
    // Audit log
    await AuditService.log(
      managerId,
      'Expense',
      expenseId,
      AuditAction.UPDATE,
      { action: 'REQUEST_CHANGES', comment }
    );

    // Emit real-time event to manager
    const updatedReport = await ExpenseReport.findById(report._id).populate('userId', 'name email').exec();
    emitManagerReportUpdate(managerId, 'EXPENSE_CHANGES_REQUESTED', updatedReport?.toObject() || report.toObject());

    // Emit real-time event to employee (expense owner)
    try {
      const { emitExpenseChangesRequestedToEmployee } = await import('../socket/realtimeEvents');
      const expenseObj = expense.toObject();
      emitExpenseChangesRequestedToEmployee(reportUserId, expenseObj);
    } catch (error) {
      logger.error({ error }, 'Error emitting expense changes requested to employee');
    }

    // Get report details for notification
    const reportDetails = await ExpenseReport.findById(report._id || report.id)
      .populate('userId', 'name email')
      .exec();

    // Send notification to employee
    try {
      await NotificationDataService.createNotification({
        userId: reportUserId,
        type: NotificationType.EXPENSE_CHANGES_REQUESTED,
        title: 'Changes Requested',
        description: `Manager requested changes for an expense in report "${reportDetails?.name || 'your report'}". ${comment ? `Comment: ${comment}` : ''}`,
        link: `/reports/${report._id || report.id}`,
        companyId: (reportDetails?.userId as any)?.companyId?.toString()
      });

      // Also send push notification
      const { NotificationService } = await import('./notification.service');
      await NotificationService.sendPushToUser(reportUserId, {
        title: 'Changes Requested',
        body: `Manager requested changes for an expense in report "${reportDetails?.name || 'your report'}"`,
        data: {
          type: 'EXPENSE_CHANGES_REQUESTED',
          reportId: (report._id || report.id).toString(),
          expenseId,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Error sending notification for expense changes request');
      // Don't fail the request if notification fails
    }

    // Emit real-time event
    emitManagerReportUpdate(managerId, 'EXPENSE_CHANGES_REQUESTED', report.toObject());

    return expense;
  }

  /**
   * Get manager dashboard stats including team-wise spending
   */
  static async getManagerDashboardStats(managerId: string): Promise<any> {
    // Get all team members (direct reports + team members)
    const teamMembers = await this.getTeamMembers(managerId);
    const teamMemberIds = teamMembers.map(m => m._id);

    if (teamMemberIds.length === 0) {
      return {
        teamSize: 0,
        pendingApprovals: 0,
        approvedThisMonth: 0,
        totalTeamSpend: 0,
        pendingReports: [],
        teamWiseSpending: [],
      };
    }

    // Get all teams managed by this manager
    const teams = await Team.find({
      managerId: new mongoose.Types.ObjectId(managerId),
      status: 'ACTIVE'
    })
      .populate('members.userId', 'name email')
      .exec();

    // Get all reports from team members
    const allReports = await ExpenseReport.find({
      userId: { $in: teamMemberIds }
    })
      .populate('userId', 'name email')
      .exec();

    // Get all expenses from team members (including draft, submitted, and approved)
    const allExpenses = await Expense.find({
      reportId: { $in: allReports.map(r => r._id) }
    }).exec();

    // Calculate pending approvals (reports with SUBMITTED status)
    const pendingReports = allReports.filter(
      r => r.status === ExpenseReportStatus.SUBMITTED
    );

    // Calculate approved this month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const approvedThisMonth = allReports.filter(
      r => 
        (r.status === ExpenseReportStatus.APPROVED || 
         r.status === ExpenseReportStatus.MANAGER_APPROVED ||
         r.status === ExpenseReportStatus.BH_APPROVED) &&
        r.approvedAt &&
        r.approvedAt >= startOfMonth
    ).length;

    // Calculate total team spend (sum of all expenses regardless of status)
    const totalTeamSpend = allExpenses.reduce(
      (sum, exp) => sum + (exp.amount || 0),
      0
    );

    // Calculate team-wise spending
    const teamWiseSpending = await Promise.all(
      teams.map(async (team) => {
        // Get team member IDs
        const teamMemberUserIds = team.members
          .map((m: any) => m.userId?._id || m.userId)
          .filter(Boolean);

        // Get reports for this team
        const teamReports = allReports.filter(
          r => teamMemberUserIds.some(
            (id: any) => 
              (r.userId as any)?._id?.toString() === id.toString() ||
              (r.userId as any)?.toString() === id.toString()
          )
        );

        // Get expenses for this team (all statuses: draft, submitted, approved)
        const teamExpenses = allExpenses.filter(
          exp => {
            if (!exp.reportId) return false;
            return teamReports.some(r => (r._id as mongoose.Types.ObjectId).toString() === exp.reportId!.toString());
          }
        );

        // Calculate spending by status
        const draftAmount = teamExpenses
          .filter(e => {
            if (!e.reportId) return false;
            if (e.status === ExpenseStatus.DRAFT) return true;
            const report = teamReports.find(r => (r._id as mongoose.Types.ObjectId).toString() === e.reportId!.toString());
            return report?.status === ExpenseReportStatus.DRAFT;
          })
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const submittedAmount = teamExpenses
          .filter(e => {
            if (!e.reportId) return false;
            const report = teamReports.find(r => (r._id as mongoose.Types.ObjectId).toString() === e.reportId!.toString());
            return report?.status === ExpenseReportStatus.SUBMITTED;
          })
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const approvedAmount = teamExpenses
          .filter(e => e.status === ExpenseStatus.APPROVED)
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const totalAmount = teamExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

        return {
          teamId: (team._id as mongoose.Types.ObjectId).toString(),
          teamName: team.name,
          totalAmount,
          draftAmount,
          submittedAmount,
          approvedAmount,
          memberCount: teamMemberUserIds.length,
        };
      })
    );

    // Also include direct reports (users with managerId but not in any team)
    const directReportIds = teamMembers
      .filter(m => {
        const userId = (m._id as any).toString();
        // Check if user is in any team
        const isInTeam = teams.some(team =>
          team.members.some((member: any) => {
            const memberId = member.userId?._id?.toString() || member.userId?.toString();
            return memberId === userId;
          })
        );
        return !isInTeam;
      })
      .map(m => m._id);

    if (directReportIds.length > 0) {
      const directReports = allReports.filter(
        r => directReportIds.some(
          (id: any) => 
            (r.userId as any)?._id?.toString() === id.toString() ||
            (r.userId as any)?.toString() === id.toString()
        )
      );

      const directReportExpenses = allExpenses.filter(
        exp => {
          if (!exp.reportId) return false;
          return directReports.some(r => (r._id as mongoose.Types.ObjectId).toString() === exp.reportId!.toString());
        }
      );

      const directDraftAmount = directReportExpenses
        .filter(e => {
          if (!e.reportId) return false;
          if (e.status === ExpenseStatus.DRAFT) return true;
          const report = directReports.find(r => (r._id as mongoose.Types.ObjectId).toString() === e.reportId!.toString());
          return report?.status === ExpenseReportStatus.DRAFT;
        })
        .reduce((sum, e) => sum + (e.amount || 0), 0);

      const directSubmittedAmount = directReportExpenses
        .filter(e => {
          if (!e.reportId) return false;
          const report = directReports.find(r => (r._id as mongoose.Types.ObjectId).toString() === e.reportId!.toString());
          return report?.status === ExpenseReportStatus.SUBMITTED;
        })
        .reduce((sum, e) => sum + (e.amount || 0), 0);

      const directApprovedAmount = directReportExpenses
        .filter(e => e.status === ExpenseStatus.APPROVED)
        .reduce((sum, e) => sum + (e.amount || 0), 0);

      const directTotalAmount = directReportExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

      if (directTotalAmount > 0 || directReportIds.length > 0) {
        teamWiseSpending.push({
          teamId: 'direct-reports',
          teamName: 'Direct Reports',
          totalAmount: directTotalAmount,
          draftAmount: directDraftAmount,
          submittedAmount: directSubmittedAmount,
          approvedAmount: directApprovedAmount,
          memberCount: directReportIds.length,
        });
      }
    }

    return {
      teamSize: teamMembers.length,
      pendingApprovals: pendingReports.length,
      approvedThisMonth,
      totalTeamSpend,
      pendingReports: pendingReports.slice(0, 5).map(r => {
        // Count expenses for this report
        const reportExpenses = allExpenses.filter(
          exp => exp.reportId && (exp.reportId as any).toString() === (r._id as mongoose.Types.ObjectId).toString()
        );
        return {
          _id: r._id,
          name: r.name,
          totalAmount: r.totalAmount || 0,
          userId: r.userId,
          expensesCount: reportExpenses.length,
        };
      }),
      teamWiseSpending,
    };
  }

  /**
   * Get team spending details with member-wise breakdown
   */
  static async getTeamSpendingDetails(
    managerId: string,
    teamId: string
  ): Promise<any> {
    // Verify manager has access to this team
    let team;
    let teamMemberUserIds: mongoose.Types.ObjectId[] = [];

    if (teamId === 'direct-reports') {
      // Handle direct reports
      const directTeamMembers = await User.find({
        managerId: new mongoose.Types.ObjectId(managerId),
        status: 'ACTIVE',
        role: UserRole.EMPLOYEE
      }).select('_id name email').exec();

      teamMemberUserIds = directTeamMembers.map(m => m._id as mongoose.Types.ObjectId);

      // Get all reports from direct reports
      const directReports = await ExpenseReport.find({
        userId: { $in: teamMemberUserIds }
      })
        .populate('userId', 'name email')
        .exec();

      // Get all expenses from direct reports
      const reportIds = directReports.map(r => r._id);
      const allExpenses = await Expense.find({
        reportId: { $in: reportIds }
      }).exec();

      // Calculate member-wise spending
      const memberSpending = directTeamMembers.map((member) => {
        const memberReports = directReports.filter(
          r => {
            const userId = (r.userId as any)?._id?.toString() || (r.userId as any)?.toString();
            return userId === (member._id as any).toString();
          }
        );

        const memberExpenses = allExpenses.filter(
          exp => {
            if (!exp.reportId) return false;
            return memberReports.some(r => (r._id as mongoose.Types.ObjectId).toString() === exp.reportId!.toString());
          }
        );

        const draftAmount = memberExpenses
          .filter(e => {
            if (!e.reportId) return false;
            if (e.status === ExpenseStatus.DRAFT) return true;
            const report = memberReports.find(r => (r._id as mongoose.Types.ObjectId).toString() === e.reportId!.toString());
            return report?.status === ExpenseReportStatus.DRAFT;
          })
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const submittedAmount = memberExpenses
          .filter(e => {
            if (!e.reportId) return false;
            const report = memberReports.find(r => (r._id as mongoose.Types.ObjectId).toString() === e.reportId!.toString());
            return report?.status === ExpenseReportStatus.SUBMITTED;
          })
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const approvedAmount = memberExpenses
          .filter(e => e.status === ExpenseStatus.APPROVED)
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const totalAmount = memberExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

        return {
          userId: (member._id as mongoose.Types.ObjectId).toString(),
          name: member.name || 'Unknown',
          email: member.email || '',
          totalAmount,
          draftAmount,
          submittedAmount,
          approvedAmount,
        };
      });

      return {
        teamId: 'direct-reports',
        teamName: 'Direct Reports',
        memberSpending,
      };
    } else {
      // Handle regular team
      team = await Team.findOne({
        _id: new mongoose.Types.ObjectId(teamId),
        managerId: new mongoose.Types.ObjectId(managerId),
        status: 'ACTIVE'
      })
        .populate('members.userId', 'name email')
        .exec();

      if (!team) {
        const error: any = new Error('Team not found');
        error.statusCode = 404;
        error.code = 'TEAM_NOT_FOUND';
        throw error;
      }

      teamMemberUserIds = team.members
        .map((m: any) => m.userId?._id || m.userId)
        .filter(Boolean) as mongoose.Types.ObjectId[];

      // Get all reports from team members
      const teamReports = await ExpenseReport.find({
        userId: { $in: teamMemberUserIds }
      })
        .populate('userId', 'name email')
        .exec();

      // Get all expenses from team members
      const reportIds = teamReports.map(r => r._id);
      const allExpenses = await Expense.find({
        reportId: { $in: reportIds }
      }).exec();

      // Calculate member-wise spending
      const memberSpending = team.members.map((member: any) => {
        const memberId = member.userId?._id || member.userId;
        const memberReports = teamReports.filter(
          r => {
            const userId = (r.userId as any)?._id?.toString() || (r.userId as any)?.toString();
            return userId === memberId.toString();
          }
        );

        const memberExpenses = allExpenses.filter(
          exp => {
            if (!exp.reportId) return false;
            return memberReports.some(r => (r._id as mongoose.Types.ObjectId).toString() === exp.reportId!.toString());
          }
        );

        const draftAmount = memberExpenses
          .filter(e => {
            if (!e.reportId) return false;
            if (e.status === ExpenseStatus.DRAFT) return true;
            const report = memberReports.find(r => (r._id as mongoose.Types.ObjectId).toString() === e.reportId!.toString());
            return report?.status === ExpenseReportStatus.DRAFT;
          })
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const submittedAmount = memberExpenses
          .filter(e => {
            if (!e.reportId) return false;
            const report = memberReports.find(r => (r._id as mongoose.Types.ObjectId).toString() === e.reportId!.toString());
            return report?.status === ExpenseReportStatus.SUBMITTED;
          })
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const approvedAmount = memberExpenses
          .filter(e => e.status === ExpenseStatus.APPROVED)
          .reduce((sum, e) => sum + (e.amount || 0), 0);

        const totalAmount = memberExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

        return {
          userId: memberId.toString(),
          name: (member.userId as any)?.name || 'Unknown',
          email: (member.userId as any)?.email || '',
          totalAmount,
          draftAmount,
          submittedAmount,
          approvedAmount,
        };
      });

      return {
        teamId: (team._id as mongoose.Types.ObjectId).toString(),
        teamName: team.name,
        memberSpending,
      };
    }
  }
}


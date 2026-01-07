import { EmployeeApprovalProfile, IEmployeeApprovalProfile } from '../models/EmployeeApprovalProfile';

export class EmployeeApprovalProfileService {
  // Get active chain for employee
  static async getActive(userId: string, companyId: string): Promise<IEmployeeApprovalProfile | null> {
    return EmployeeApprovalProfile.findOne({ userId, companyId, active: true });
  }

  // Set/update chain manually, deactivate previous
  static async setManualChain(userId: string, companyId: string, approverChain: any[]): Promise<IEmployeeApprovalProfile> {
    // Deactivate any current manual or ai profile
    await EmployeeApprovalProfile.updateMany({ userId, companyId, active: true }, { $set: { active: false } });
    // Save new manual
    return EmployeeApprovalProfile.create({
      userId,
      companyId,
      approverChain,
      source: 'manual',
      version: Date.now(),
      active: true,
    });
  }

  // Admin: Clear chain (to force fallback)
  static async clearChain(userId: string, companyId: string) {
    await EmployeeApprovalProfile.updateMany({ userId, companyId, active: true }, { $set: { active: false } });
  }

  // Company Admin: list active profiles for the whole company (for dashboard badges)
  static async listActiveForCompany(companyId: string) {
    return EmployeeApprovalProfile.find({ companyId, active: true })
      .select('userId source confidenceScore updatedAt')
      .lean()
      .exec();
  }

  // List all employee manual/AI chains in a department
  static async listDepartmentProfiles(_departmentId: string, companyId: string) {
    return EmployeeApprovalProfile.find({ companyId, 'approverChain.roles': { $exists: true }, active: true })
      .populate('userId')
      .lean();
  }

  // Editors: mark AI/auto chain as preferred (reactivate)
  static async setAIChainActive(userId: string, companyId: string) {
    return EmployeeApprovalProfile.updateMany({ userId, companyId, source: 'manual', active: true }, { $set: { active: false } });
    // Activate most recent AI (if exists)
  }
}


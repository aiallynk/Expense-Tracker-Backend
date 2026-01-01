import mongoose from 'mongoose';
import { User, IUser } from '../models/User';
import { ApproverMapping, IApproverMapping } from '../models/ApproverMapping';
import { UserRole, UserStatus } from '../utils/enums';
import { logger } from '@/config/logger';

/**
 * Business Head Selection Service
 * 
 * Centralized logic for determining Level 2 (Business Head) approver.
 * This service implements a clear priority-based selection algorithm.
 * 
 * SELECTION PRIORITY ORDER:
 * 1. Custom Approver Mapping (L2 if defined) - Highest priority
 * 2. Active BUSINESS_HEAD in same department as employee
 * 3. Manager's manager (if role = BUSINESS_HEAD)
 * 4. Fallback to any active BUSINESS_HEAD or ADMIN in company
 * 
 * BUSINESS HEAD ASSIGNMENT RULES:
 * - Business Head is ALWAYS determined by department ownership
 * - After Manager (L1) approval, system automatically assigns the Business Head
 * - Manager does not choose the BH manually
 * 
 * @example
 * // Example 1: Employee in Sales department
 * // Priority 2: Finds BH with role BUSINESS_HEAD in Sales department
 * 
 * // Example 2: Employee has custom mapping
 * // Priority 1: Uses level2ApproverId from ApproverMapping
 * 
 * // Example 3: Manager's manager is BUSINESS_HEAD
 * // Priority 3: Uses manager's manager as BH
 */
export class BusinessHeadSelectionService {
  /**
   * Select Business Head for an employee's expense report
   * 
   * This is the main entry point for BH selection. It follows the priority order:
   * 1. Custom Mapping (if provided)
   * 2. Department-based BH
   * 3. Manager's manager (if BUSINESS_HEAD)
   * 4. Company-wide fallback
   * 
   * @param employeeId - ID of the employee submitting the report
   * @param companyId - Company ID (optional, will be fetched if not provided)
   * @param customMapping - Optional custom approver mapping (if already fetched)
   * @param managerId - Optional manager ID (if already known)
   * @returns Business Head user or null if none found
   */
  static async selectBusinessHead(
    employeeId: string,
    companyId?: string,
    customMapping?: IApproverMapping | null,
    managerId?: string
  ): Promise<IUser | null> {
    try {
      // Fetch employee if needed
      const employee = await User.findById(employeeId).exec();
      if (!employee) {
        logger.warn({ employeeId }, 'Employee not found for BH selection');
        return null;
      }

      const empCompanyId = companyId || employee.companyId?.toString();
      if (!empCompanyId) {
        logger.warn({ employeeId }, 'Employee has no company ID');
        return null;
      }

      // Priority 1: Custom Approver Mapping (L2 if defined)
      if (customMapping?.level2ApproverId) {
        const customBH = await User.findById(customMapping.level2ApproverId).exec();
        if (customBH && customBH.status === UserStatus.ACTIVE) {
          logger.info(
            { employeeId, bhId: customBH._id, method: 'custom_mapping' },
            'BH selected via custom mapping'
          );
          return customBH;
        }
      } else if (!customMapping) {
        // Only check for custom mapping if not already provided
        const mapping = await ApproverMapping.findOne({
          userId: new mongoose.Types.ObjectId(employeeId),
          companyId: new mongoose.Types.ObjectId(empCompanyId),
          isActive: true,
        }).exec();

        if (mapping?.level2ApproverId) {
          const customBH = await User.findById(mapping.level2ApproverId).exec();
          if (customBH && customBH.status === UserStatus.ACTIVE) {
            logger.info(
              { employeeId, bhId: customBH._id, method: 'custom_mapping' },
              'BH selected via custom mapping'
            );
            return customBH;
          }
        }
      }

      // Priority 2: Active BUSINESS_HEAD in same department as employee
      if (employee.departmentId) {
        const departmentBH = await this.findBusinessHeadByDepartment(
          employee.departmentId.toString(),
          empCompanyId
        );
        if (departmentBH) {
          logger.info(
            { employeeId, bhId: departmentBH._id, departmentId: employee.departmentId, method: 'department' },
            'BH selected via department ownership'
          );
          return departmentBH;
        }
      }

      // Priority 3: Manager's manager (if role = BUSINESS_HEAD)
      const empManagerId = managerId || employee.managerId?.toString();
      if (empManagerId) {
        const manager = await User.findById(empManagerId).exec();
        if (manager?.managerId) {
          const managersManager = await User.findById(manager.managerId).exec();
          if (
            managersManager &&
            managersManager.status === UserStatus.ACTIVE &&
            managersManager.role === UserRole.BUSINESS_HEAD
          ) {
            logger.info(
              { employeeId, bhId: managersManager._id, method: 'managers_manager' },
              'BH selected via manager hierarchy'
            );
            return managersManager;
          }
        }
      }

      // Priority 4: Fallback to any active BUSINESS_HEAD or ADMIN in company
      const fallbackBH = await this.findCompanyFallbackBusinessHead(empCompanyId);
      if (fallbackBH) {
        logger.info(
          { employeeId, bhId: fallbackBH._id, method: 'company_fallback' },
          'BH selected via company fallback'
        );
        return fallbackBH;
      }

      logger.warn(
        { employeeId, companyId: empCompanyId },
        'No Business Head found for employee - all priority levels exhausted'
      );
      return null;
    } catch (error) {
      logger.error({ error, employeeId, companyId }, 'Error selecting Business Head');
      return null;
    }
  }

  /**
   * Find Business Head by department
   * 
   * Searches for an active BUSINESS_HEAD user in the specified department.
   * If multiple BHs exist in the department, returns the first active one found.
   * 
   * @param departmentId - Department ID to search in
   * @param companyId - Company ID for validation
   * @returns Business Head user or null if none found
   */
  static async findBusinessHeadByDepartment(
    departmentId: string,
    companyId: string
  ): Promise<IUser | null> {
    try {
      const businessHead = await User.findOne({
        departmentId: new mongoose.Types.ObjectId(departmentId),
        companyId: new mongoose.Types.ObjectId(companyId),
        role: UserRole.BUSINESS_HEAD,
        status: UserStatus.ACTIVE,
      }).exec();

      // Edge case: Multiple BHs in same department
      // Currently returns first found. Future enhancement: Add priority field
      if (businessHead) {
        return businessHead;
      }

      return null;
    } catch (error) {
      logger.error({ error, departmentId, companyId }, 'Error finding BH by department');
      return null;
    }
  }

  /**
   * Find company-wide fallback Business Head or Admin
   * 
   * Used as last resort when no department-specific BH is found.
   * Prioritizes BUSINESS_HEAD over ADMIN.
   * 
   * @param companyId - Company ID to search in
   * @returns Business Head or Admin user, or null if none found
   */
  static async findCompanyFallbackBusinessHead(companyId: string): Promise<IUser | null> {
    try {
      // First try to find a BUSINESS_HEAD
      const businessHead = await User.findOne({
        companyId: new mongoose.Types.ObjectId(companyId),
        role: UserRole.BUSINESS_HEAD,
        status: UserStatus.ACTIVE,
      }).exec();

      if (businessHead) {
        return businessHead;
      }

      // Fallback to ADMIN if no BUSINESS_HEAD found
      const admin = await User.findOne({
        companyId: new mongoose.Types.ObjectId(companyId),
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
      }).exec();

      if (admin) {
        logger.warn(
          { companyId },
          'No BUSINESS_HEAD found, using ADMIN as fallback'
        );
        return admin;
      }

      // Last resort: COMPANY_ADMIN
      const companyAdmin = await User.findOne({
        companyId: new mongoose.Types.ObjectId(companyId),
        role: UserRole.COMPANY_ADMIN,
        status: UserStatus.ACTIVE,
      }).exec();

      if (companyAdmin) {
        logger.warn(
          { companyId },
          'No BUSINESS_HEAD or ADMIN found, using COMPANY_ADMIN as fallback'
        );
        return companyAdmin;
      }

      return null;
    } catch (error) {
      logger.error({ error, companyId }, 'Error finding company fallback BH');
      return null;
    }
  }

  /**
   * Validate Business Head assignment
   * 
   * Checks if a Business Head assignment is valid for an employee.
   * Validates department match, company match, and active status.
   * 
   * @param bhId - Business Head user ID
   * @param employeeId - Employee user ID
   * @returns Validation result with reason if invalid
   */
  static async validateBusinessHeadAssignment(
    bhId: string,
    employeeId: string
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      const businessHead = await User.findById(bhId).exec();
      const employee = await User.findById(employeeId).exec();

      if (!businessHead) {
        return { valid: false, reason: 'Business Head not found' };
      }

      if (!employee) {
        return { valid: false, reason: 'Employee not found' };
      }

      if (businessHead.status !== UserStatus.ACTIVE) {
        return { valid: false, reason: 'Business Head is not active' };
      }

      if (businessHead.companyId?.toString() !== employee.companyId?.toString()) {
        return { valid: false, reason: 'Business Head and employee belong to different companies' };
      }

      // Department validation: BH should be in same department OR be company-wide fallback
      if (
        employee.departmentId &&
        businessHead.departmentId &&
        businessHead.departmentId.toString() !== employee.departmentId.toString()
      ) {
        // This is a warning, not an error - company-wide BHs can approve across departments
        logger.warn(
          { bhId, employeeId, bhDept: businessHead.departmentId, empDept: employee.departmentId },
          'BH and employee in different departments (may be company-wide BH)'
        );
      }

      return { valid: true };
    } catch (error) {
      logger.error({ error, bhId, employeeId }, 'Error validating BH assignment');
      return { valid: false, reason: 'Validation error occurred' };
    }
  }

  /**
   * Get selection explanation for admin UI
   * 
   * Returns a human-readable explanation of how the BH was selected.
   * Useful for displaying in admin interfaces and audit logs.
   * 
   * @param employeeId - Employee ID
   * @param companyId - Company ID
   * @returns Explanation text and selection method
   */
  static async getSelectionExplanation(
    employeeId: string,
    companyId?: string
  ): Promise<{ explanation: string; method: string }> {
    try {
      const employee = await User.findById(employeeId)
        .populate('departmentId', 'name')
        .exec();

      if (!employee) {
        return {
          explanation: 'Employee not found',
          method: 'unknown',
        };
      }

      const empCompanyId = companyId || employee.companyId?.toString();
      const customMapping = await ApproverMapping.findOne({
        userId: new mongoose.Types.ObjectId(employeeId),
        companyId: new mongoose.Types.ObjectId(empCompanyId || ''),
        isActive: true,
      }).exec();

      // Check each priority level
      if (customMapping?.level2ApproverId) {
        const customBH = await User.findById(customMapping.level2ApproverId).exec();
        if (customBH) {
          return {
            explanation: `Business Head "${customBH.name}" selected via custom approver mapping`,
            method: 'custom_mapping',
          };
        }
      }

      if (employee.departmentId) {
        const deptBH = await this.findBusinessHeadByDepartment(
          (employee.departmentId as any)._id?.toString() || employee.departmentId.toString(),
          empCompanyId || ''
        );
        if (deptBH) {
          const deptName = (employee.departmentId as any)?.name || 'the department';
          return {
            explanation: `Business Head "${deptBH.name}" selected from ${deptName} (department ownership)`,
            method: 'department',
          };
        }
      }

      if (employee.managerId) {
        const manager = await User.findById(employee.managerId).exec();
        if (manager?.managerId) {
          const managersManager = await User.findById(manager.managerId).exec();
          if (managersManager?.role === UserRole.BUSINESS_HEAD) {
            return {
              explanation: `Business Head "${managersManager.name}" selected via manager hierarchy (manager's manager)`,
              method: 'managers_manager',
            };
          }
        }
      }

      const fallbackBH = await this.findCompanyFallbackBusinessHead(empCompanyId || '');
      if (fallbackBH) {
        return {
          explanation: `Business Head "${fallbackBH.name}" selected via company-wide fallback`,
          method: 'company_fallback',
        };
      }

      return {
        explanation: 'No Business Head found - all selection methods exhausted',
        method: 'none',
      };
    } catch (error) {
      logger.error({ error, employeeId }, 'Error getting selection explanation');
      return {
        explanation: 'Error generating explanation',
        method: 'error',
      };
    }
  }
}


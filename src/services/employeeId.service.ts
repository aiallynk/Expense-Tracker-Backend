import mongoose from 'mongoose';

import { Company } from '../models/Company';
import { User } from '../models/User';

import { logger } from '@/config/logger';


export class EmployeeIdService {
  /**
   * Generate a unique employee ID based on company shortcut and sequential number
   * Format: {COMPANY_SHORTCUT}{NUMBER} (e.g., ABC001, XYZ042)
   */
  static async generateEmployeeId(
    companyId: string | mongoose.Types.ObjectId,
    userId?: string | mongoose.Types.ObjectId
  ): Promise<string> {
    try {
      // Get company to retrieve shortcut
      const company = await Company.findById(companyId).select('shortcut name').exec();
      
      if (!company) {
        throw new Error('Company not found');
      }

      // Get or generate company shortcut
      let shortcut = company.shortcut;
      
      if (!shortcut) {
        // Generate shortcut from company name (first 3 uppercase letters)
        shortcut = company.name
          .replace(/[^a-zA-Z0-9]/g, '') // Remove special characters
          .substring(0, 3)
          .toUpperCase();
        
        // If name is too short, pad with X
        while (shortcut.length < 3) {
          shortcut += 'X';
        }
        
        // Save the shortcut to company
        company.shortcut = shortcut;
        await company.save();
        
        logger.info(`Generated company shortcut: ${shortcut} for company: ${company.name}`);
      }

      // Find the highest employee ID number for this company
      const companyUsers = await User.find({
        companyId: new mongoose.Types.ObjectId(companyId),
        employeeId: { $exists: true, $ne: null },
      })
        .select('employeeId')
        .exec();

      // Extract numbers from existing employee IDs
      const existingNumbers = companyUsers
        .map(user => {
          if (!user.employeeId) return 0;
          // Extract number from employeeId (e.g., "ABC001" -> 1)
          const match = user.employeeId.match(/\d+$/);
          return match ? parseInt(match[0], 10) : 0;
        })
        .filter(num => num > 0);

      // If updating existing user, exclude their current employeeId
      if (userId) {
        const currentUser = await User.findById(userId).select('employeeId').exec();
        if (currentUser?.employeeId) {
          const currentMatch = currentUser.employeeId.match(/\d+$/);
          if (currentMatch) {
            const currentNum = parseInt(currentMatch[0], 10);
            const index = existingNumbers.indexOf(currentNum);
            if (index > -1) {
              existingNumbers.splice(index, 1);
            }
          }
        }
      }

      // Get the next sequential number
      const maxNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0;
      const nextNumber = maxNumber + 1;

      // Format number with leading zeros (001, 002, etc.)
      const formattedNumber = nextNumber.toString().padStart(3, '0');

      // Generate employee ID
      const employeeId = `${shortcut}${formattedNumber}`;

      // Ensure uniqueness (in case of race condition)
      const existing = await User.findOne({ employeeId }).exec();
      if (existing && (existing._id as any).toString() !== (userId?.toString() || '')) {
        // If collision, try next number
        const nextAttempt = (nextNumber + 1).toString().padStart(3, '0');
        return `${shortcut}${nextAttempt}`;
      }

      logger.info(`Generated employee ID: ${employeeId} for company: ${company.name}`);
      return employeeId;
    } catch (error: any) {
      logger.error({ error }, 'Error generating employee ID:');
      throw new Error(`Failed to generate employee ID: ${error.message}`);
    }
  }

  /**
   * Auto-generate and assign employee ID when company/department is set
   */
  static async assignEmployeeId(
    userId: string | mongoose.Types.ObjectId,
    companyId?: string | mongoose.Types.ObjectId,
    _departmentId?: string | mongoose.Types.ObjectId
  ): Promise<string | null> {
    try {
      const user = await User.findById(userId).exec();
      
      if (!user) {
        throw new Error('User not found');
      }

      // Only generate ID if user has company
      const targetCompanyId = companyId || user.companyId;
      
      if (!targetCompanyId) {
        logger.debug(`User ${userId} has no company, skipping employee ID generation`);
        return null;
      }

      // Only generate if user doesn't already have an employeeId
      // OR if company has changed (need to regenerate)
      const currentCompanyId = user.companyId?.toString();
      const newCompanyId = targetCompanyId.toString();
      
      if (user.employeeId && currentCompanyId === newCompanyId) {
        // User already has ID and company hasn't changed
        logger.debug(`User ${userId} already has employee ID: ${user.employeeId}`);
        return user.employeeId;
      }

      // Generate new employee ID
      const employeeId = await this.generateEmployeeId(targetCompanyId, userId);
      
      // Update user with new employee ID
      user.employeeId = employeeId;
      await user.save();

      logger.info(`Assigned employee ID ${employeeId} to user ${userId}`);
      return employeeId;
    } catch (error: any) {
      logger.error({ error }, 'Error assigning employee ID:');
      throw error;
    }
  }
}


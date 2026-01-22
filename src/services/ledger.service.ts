import mongoose from 'mongoose';

import { Ledger, LedgerEntryType, ILedger } from '../models/Ledger';
import { getFinancialYear } from '../utils/financialYear';
import { AuditService } from './audit.service';
import { AuditAction } from '../utils/enums';

import { logger } from '@/config/logger';

export interface CreateLedgerEntryParams {
  companyId: string;
  entryType: LedgerEntryType;
  voucherId?: string;
  reportId?: string;
  userId: string;
  amount: number;
  currency: string;
  debitAccount?: string;
  creditAccount?: string;
  description: string;
  referenceId?: string;
  entryDate: Date;
  createdBy: string;
}

export class LedgerService {
  /**
   * Create a ledger entry
   */
  static async createEntry(params: CreateLedgerEntryParams): Promise<ILedger> {
    // Validate entry data
    if (!params.companyId || !params.userId || !params.createdBy) {
      throw new Error('Missing required fields for ledger entry');
    }

    if (!isFinite(params.amount) || params.amount <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    // Determine financial year from entryDate
    const { year: financialYear } = getFinancialYear(params.entryDate);

    const ledgerEntry = new Ledger({
      companyId: new mongoose.Types.ObjectId(params.companyId),
      entryType: params.entryType,
      voucherId: params.voucherId ? new mongoose.Types.ObjectId(params.voucherId) : undefined,
      reportId: params.reportId ? new mongoose.Types.ObjectId(params.reportId) : undefined,
      userId: new mongoose.Types.ObjectId(params.userId),
      amount: params.amount,
      currency: (params.currency || 'INR').toUpperCase(),
      debitAccount: params.debitAccount,
      creditAccount: params.creditAccount,
      description: params.description,
      referenceId: params.referenceId,
      financialYear,
      entryDate: params.entryDate,
      createdBy: new mongoose.Types.ObjectId(params.createdBy),
    });

    const saved = await ledgerEntry.save();

    // Log audit entry
    try {
      await AuditService.log(
        params.createdBy,
        'Ledger',
        (saved._id as mongoose.Types.ObjectId).toString(),
        AuditAction.CREATE,
        {
          entryType: params.entryType,
          amount: params.amount,
          currency: params.currency,
          financialYear,
        }
      );
    } catch (error) {
      logger.error({ error, ledgerId: saved._id }, 'Failed to create audit log for ledger entry');
      // Don't fail ledger creation if audit log fails
    }

    return saved;
  }

  /**
   * Get all ledger entries for a voucher
   */
  static async getVoucherLedger(voucherId: string): Promise<ILedger[]> {
    if (!mongoose.Types.ObjectId.isValid(voucherId)) {
      throw new Error('Invalid voucher ID');
    }

    return Ledger.find({
      voucherId: new mongoose.Types.ObjectId(voucherId),
    })
      .populate('userId', 'name email')
      .populate('reportId', 'name status')
      .populate('createdBy', 'name email')
      .sort({ entryDate: -1, createdAt: -1 })
      .exec();
  }

  /**
   * Get ledger entries for a report
   */
  static async getReportLedger(reportId: string): Promise<ILedger[]> {
    if (!mongoose.Types.ObjectId.isValid(reportId)) {
      throw new Error('Invalid report ID');
    }

    return Ledger.find({
      reportId: new mongoose.Types.ObjectId(reportId),
    })
      .populate('voucherId', 'voucherCode totalAmount currency')
      .populate('userId', 'name email')
      .populate('createdBy', 'name email')
      .sort({ entryDate: -1, createdAt: -1 })
      .exec();
  }

  /**
   * Get company-wide ledger entries
   */
  static async getCompanyLedger(params: {
    companyId: string;
    financialYear?: string;
    entryType?: LedgerEntryType;
    startDate?: Date;
    endDate?: Date;
    userId?: string;
    limit?: number;
    skip?: number;
  }): Promise<{ entries: ILedger[]; total: number }> {
    if (!mongoose.Types.ObjectId.isValid(params.companyId)) {
      throw new Error('Invalid company ID');
    }

    const query: any = {
      companyId: new mongoose.Types.ObjectId(params.companyId),
    };

    if (params.financialYear) {
      query.financialYear = params.financialYear;
    }

    if (params.entryType) {
      query.entryType = params.entryType;
    }

    if (params.startDate || params.endDate) {
      query.entryDate = {};
      if (params.startDate) {
        query.entryDate.$gte = params.startDate;
      }
      if (params.endDate) {
        query.entryDate.$lte = params.endDate;
      }
    }

    if (params.userId) {
      query.userId = new mongoose.Types.ObjectId(params.userId);
    }

    const total = await Ledger.countDocuments(query).exec();

    const entries = await Ledger.find(query)
      .populate('voucherId', 'voucherCode totalAmount currency')
      .populate('reportId', 'name status')
      .populate('userId', 'name email')
      .populate('createdBy', 'name email')
      .sort({ entryDate: -1, createdAt: -1 })
      .limit(params.limit || 100)
      .skip(params.skip || 0)
      .exec();

    return { entries, total };
  }
}

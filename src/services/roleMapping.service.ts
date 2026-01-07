import { Role } from '../models/Role';

import { logger } from '@/config/logger';

/**
 * Find a roleId by its code or name for a company. Used for AI output to internal mapping.
 * @param companyId string
 * @param codesOrNames string[]
 * @returns Promise<string[]>
 */
export async function mapRoleCodesToIds(companyId: string, codesOrNames: string[]): Promise<string[]> {
  if (!codesOrNames || codesOrNames.length === 0) return [];
  const roleDocs = await Role.find({
    companyId,
    $or: [
      { name: { $in: codesOrNames } },
      // Add mappings for future: code field, shortName, etc.
    ]
  }).exec();
  if (roleDocs.length < codesOrNames.length) {
    logger.warn({
      attempted: codesOrNames,
      found: roleDocs.map(r => r.name),
    }, 'roleMapping: Some roles not found');
  }
  // Return sorted by requested input order (possible multiple matches)
  return codesOrNames.map(code => {
    const match = roleDocs.find(r => r.name === code);
    return match ? (match._id as any).toString() : null;
  }).filter(Boolean) as string[];
}


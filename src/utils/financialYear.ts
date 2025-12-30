/**
 * Financial Year Utility Functions
 * Handles financial year calculations based on company settings
 */

export interface FinancialYearConfig {
  startMonth: number; // 1-12
  startDay: number; // 1-31
  endMonth: number; // 1-12
  endDay: number; // 1-31
}

/**
 * Get the financial year for a given date
 * @param date - The date to get FY for
 * @param config - Financial year configuration (default: April 1 - March 31)
 * @returns Object with start and end dates of the financial year
 */
export function getFinancialYear(
  date: Date,
  config: FinancialYearConfig = {
    startMonth: 4, // April
    startDay: 1,
    endMonth: 3, // March
    endDay: 31,
  }
): { startDate: Date; endDate: Date; year: string } {
  const inputDate = new Date(date);
  const currentYear = inputDate.getFullYear();
  const currentMonth = inputDate.getMonth() + 1; // 1-12

  let fyStartYear: number;
  let fyEndYear: number;

  // If current month is before the FY start month, FY started in previous year
  if (currentMonth < config.startMonth) {
    fyStartYear = currentYear - 1;
    fyEndYear = currentYear;
  } else if (currentMonth === config.startMonth) {
    // If current month is the start month, check the day
    if (inputDate.getDate() < config.startDay) {
      fyStartYear = currentYear - 1;
      fyEndYear = currentYear;
    } else {
      fyStartYear = currentYear;
      fyEndYear = currentYear + 1;
    }
  } else {
    // Current month is after start month
    fyStartYear = currentYear;
    fyEndYear = currentYear + 1;
  }

  const startDate = new Date(fyStartYear, config.startMonth - 1, config.startDay);
  const endDate = new Date(fyEndYear, config.endMonth - 1, config.endDay);

  // Format: FY2024-25 (for April 2024 - March 2025)
  const year = `FY${fyStartYear}-${String(fyEndYear).slice(-2)}`;

  return { startDate, endDate, year };
}

/**
 * Check if a date falls within a financial year
 */
export function isDateInFinancialYear(
  date: Date,
  fyStartDate: Date,
  fyEndDate: Date
): boolean {
  const checkDate = new Date(date);
  return checkDate >= fyStartDate && checkDate <= fyEndDate;
}

/**
 * Get current financial year
 */
export function getCurrentFinancialYear(
  config: FinancialYearConfig = {
    startMonth: 4,
    startDay: 1,
    endMonth: 3,
    endDay: 31,
  }
): { startDate: Date; endDate: Date; year: string } {
  return getFinancialYear(new Date(), config);
}


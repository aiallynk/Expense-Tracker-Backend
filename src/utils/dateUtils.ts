import moment from 'moment-timezone';

/**
 * IST Date Utilities - Ensures all dates are handled in Asia/Kolkata timezone
 * Prevents the -1 day issue caused by UTC/local timezone conversions
 */

const IST_TIMEZONE = 'Asia/Kolkata';

export class DateUtils {

  /**
   * Parse a date string (YYYY-MM-DD) as IST date
   * Avoids timezone conversion issues by treating the string as a calendar date in IST
   */
  static parseISTDate(dateString: string): Date {
    if (!dateString) return new Date();

    // Validate format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateString)) {
      throw new Error('Date must be in YYYY-MM-DD format');
    }

    // Create date in IST timezone at midnight
    const istDate = moment.tz(dateString, 'YYYY-MM-DD', IST_TIMEZONE);

    // Return as JavaScript Date object (will be stored as UTC in MongoDB)
    return istDate.toDate();
  }

  /**
   * Format a Date object to YYYY-MM-DD string in IST
   */
  static formatISTDate(date: Date): string {
    if (!date) return '';
    return moment(date).tz(IST_TIMEZONE).format('YYYY-MM-DD');
  }

  /**
   * Create a date range query for MongoDB that includes full days in IST
   * This ensures startDate and endDate are inclusive
   */
  static createDateRangeQuery(startDate: string, endDate: string) {
    // Parse dates as IST and get start of day / end of day
    const startIST = moment.tz(startDate, 'YYYY-MM-DD', IST_TIMEZONE).startOf('day');
    const endIST = moment.tz(endDate, 'YYYY-MM-DD', IST_TIMEZONE).endOf('day');

    return {
      $gte: startIST.toDate(),
      $lte: endIST.toDate(),
    };
  }

  /**
   * Convert frontend date string to backend Date object
   * Frontend sends "YYYY-MM-DD" strings, backend needs Date objects
   */
  static frontendDateToBackend(dateString: string): Date {
    return DateUtils.parseISTDate(dateString);
  }

  /**
   * Convert backend Date object to frontend date string
   * Backend sends Date objects, frontend needs "YYYY-MM-DD" strings
   */
  static backendDateToFrontend(date: Date): string {
    return DateUtils.formatISTDate(date);
  }

  /**
   * Get current date in IST as YYYY-MM-DD string
   */
  static getCurrentISTDate(): string {
    return moment().tz(IST_TIMEZONE).format('YYYY-MM-DD');
  }

  /**
   * Validate date string format
   */
  static isValidDateString(dateString: string): boolean {
    if (!dateString) return false;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateString)) return false;

    const date = moment(dateString, 'YYYY-MM-DD', true);
    return date.isValid();
  }

  /**
   * Get start and end of day in IST for a given date
   */
  static getISTDayRange(dateString: string) {
    const dateIST = moment.tz(dateString, 'YYYY-MM-DD', IST_TIMEZONE);
    return {
      start: dateIST.startOf('day').toDate(),
      end: dateIST.endOf('day').toDate(),
    };
  }

  /**
   * Check if expense date (IST calendar day) is within report [fromDate, toDate] inclusive.
   * Used for API validation (plan §4.1).
   */
  static isDateInReportRange(expenseDate: Date, fromDate: Date, toDate: Date): boolean {
    const exp = moment(expenseDate).tz(IST_TIMEZONE).format('YYYY-MM-DD');
    const from = moment(fromDate).tz(IST_TIMEZONE).format('YYYY-MM-DD');
    const to = moment(toDate).tz(IST_TIMEZONE).format('YYYY-MM-DD');
    return exp >= from && exp <= to;
  }
}
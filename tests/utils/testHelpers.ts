import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { User, IUser } from '../../src/models/User';
import { CompanyAdmin, ICompanyAdmin, CompanyAdminStatus } from '../../src/models/CompanyAdmin';
import { Company, ICompany } from '../../src/models/Company';
import { ExpenseReport, IExpenseReport } from '../../src/models/ExpenseReport';
import { Expense, IExpense } from '../../src/models/Expense';
import { Category, ICategory } from '../../src/models/Category';
import { UserRole, UserStatus, ExpenseReportStatus, ExpenseStatus } from '../../src/utils/enums';
import { config } from '../../src/config/index';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  token?: string;
  role: UserRole;
  companyId?: string;
}

/**
 * Create a test company
 */
export async function createTestCompany(name: string = 'Test Company'): Promise<string> {
  const company = new Company({
    name,
    domain: `${name.toLowerCase().replace(/\s+/g, '-')}.com`,
  });
  const saved = await company.save();
  return saved._id.toString();
}

/**
 * Create a test user with hashed password
 */
export async function createTestUser(
  email: string,
  password: string,
  role: UserRole = UserRole.EMPLOYEE,
  companyId?: string,
  status: UserStatus = UserStatus.ACTIVE
): Promise<TestUser> {
  const passwordHash = await bcrypt.hash(password, 10);
  
  const userData: any = {
    email: email.toLowerCase().trim(),
    passwordHash,
    name: email.split('@')[0],
    role,
    status,
  };

  if (companyId) {
    userData.companyId = new mongoose.Types.ObjectId(companyId);
  }

  const user = new User(userData);
  const saved = await user.save();

  return {
    id: saved._id.toString(),
    email: saved.email,
    password,
    role: saved.role as UserRole,
    companyId: companyId,
  };
}

/**
 * Create a test company admin
 */
export async function createTestCompanyAdmin(
  email: string,
  password: string,
  companyId: string,
  status: string = 'ACTIVE'
): Promise<TestUser> {
  const passwordHash = await bcrypt.hash(password, 10);
  
  const admin = new CompanyAdmin({
    email: email.toLowerCase().trim(),
    passwordHash,
    name: email.split('@')[0],
    companyId: new mongoose.Types.ObjectId(companyId),
    status: status === 'ACTIVE' ? CompanyAdminStatus.ACTIVE : CompanyAdminStatus.INACTIVE,
  });
  
  const saved = await admin.save();

  return {
    id: saved._id.toString(),
    email: saved.email,
    password,
    role: UserRole.COMPANY_ADMIN,
    companyId,
  };
}

/**
 * Create a test category
 */
export async function createTestCategory(
  name: string,
  companyId?: string
): Promise<ICategory> {
  const category = new Category({
    name,
    status: 'ACTIVE',
    isCustom: true,
    companyId: companyId ? new mongoose.Types.ObjectId(companyId) : undefined,
  });
  return await category.save();
}

/**
 * Create a test expense report
 */
export async function createTestReport(
  userId: string,
  companyId?: string,
  status: ExpenseReportStatus = ExpenseReportStatus.DRAFT,
  name?: string
): Promise<IExpenseReport> {
  const reportData: any = {
    userId: new mongoose.Types.ObjectId(userId),
    name: name || 'Test Report',
    fromDate: new Date('2024-01-01'),
    toDate: new Date('2024-01-31'),
    status,
    totalAmount: 0,
    currency: 'INR',
    approvers: [],
  };
  
  const report = new ExpenseReport(reportData);
  return await report.save();
}

/**
 * Create a test expense
 */
export async function createTestExpense(
  userId: string,
  reportId: string,
  categoryId?: string,
  amount: number = 100,
  expenseDate?: Date
): Promise<IExpense> {
  const expense = new Expense({
    userId: new mongoose.Types.ObjectId(userId),
    reportId: new mongoose.Types.ObjectId(reportId),
    vendor: 'Test Vendor',
    amount,
    currency: 'INR',
    expenseDate: expenseDate || new Date(),
    status: ExpenseStatus.PENDING,
    source: 'MANUAL',
    receiptIds: [],
    categoryId: categoryId ? new mongoose.Types.ObjectId(categoryId) : undefined,
  });
  return await expense.save();
}

/**
 * Generate JWT token for testing (simplified - in real tests, use AuthService)
 */
export function generateTestToken(user: TestUser): string {
  // For testing, we'll use a simple mock token
  // In real implementation, use AuthService.login or jwt.sign
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  };
  
  // This is a mock - in actual tests, use the real JWT signing
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Wait for a specified time (for concurrency tests)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate an expired JWT access token for testing
 */
export function generateExpiredAccessToken(user: TestUser): string {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  };
  
  // Set expiration to 1 second ago
  const secret = String(config.jwt.accessSecret);
  return jwt.sign(payload, secret, { expiresIn: '-1s' });
}

/**
 * Generate a valid JWT access token with custom expiration
 */
export function generateAccessTokenWithExpiration(
  user: TestUser,
  expiresIn: string | number
): string {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  };
  
  const secret = String(config.jwt.accessSecret);
  return jwt.sign(payload, secret, { expiresIn });
}

/**
 * Generate an expired JWT refresh token for testing
 */
export function generateExpiredRefreshToken(user: TestUser): string {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  };
  
  // Set expiration to 1 second ago
  const secret = String(config.jwt.refreshSecret);
  return jwt.sign(payload, secret, { expiresIn: '-1s' });
}

/**
 * Generate a valid JWT refresh token
 */
export function generateRefreshToken(user: TestUser): string {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  };
  
  const secret = String(config.jwt.refreshSecret);
  return jwt.sign(payload, secret, { expiresIn: config.jwt.refreshExpiresIn });
}

/**
 * Create multiple test expenses quickly for pagination/filtering tests
 */
export async function createMultipleTestExpenses(
  userId: string,
  reportId: string,
  categoryId: string,
  count: number,
  baseAmount: number = 100
): Promise<IExpense[]> {
  const expenses: IExpense[] = [];
  
  for (let i = 0; i < count; i++) {
    const expense = new Expense({
      userId: new mongoose.Types.ObjectId(userId),
      reportId: new mongoose.Types.ObjectId(reportId),
      vendor: `Test Vendor ${i + 1}`,
      amount: baseAmount + i * 10,
      currency: 'INR',
      expenseDate: new Date(2024, 0, 1 + i), // Different dates
      status: ExpenseStatus.PENDING,
      source: 'MANUAL',
      receiptIds: [],
      categoryId: new mongoose.Types.ObjectId(categoryId),
    });
    expenses.push(await expense.save());
  }
  
  return expenses;
}

/**
 * Verify S3 mock state - check if object exists
 */
export async function verifyS3ObjectExists(
  bucket: string,
  key: string
): Promise<boolean> {
  const { mockS3 } = await import('./s3Mock');
  return await mockS3.objectExists(bucket, key);
}

/**
 * Verify S3 mock state - check if object was deleted
 */
export function verifyS3ObjectWasDeleted(bucket: string, key: string): boolean {
  const { mockS3 } = require('./s3Mock');
  return mockS3.wasDeleted(bucket, key);
}

/**
 * Get S3 mock object count for a bucket
 */
export function getS3ObjectCount(bucket: string): number {
  const { mockS3 } = require('./s3Mock');
  return mockS3.getObjectCount(bucket);
}

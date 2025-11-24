import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { config } from '../config/index';
import { CompanyAdmin, ICompanyAdmin , CompanyAdminStatus } from '../models/CompanyAdmin';
import { User, IUser } from '../models/User';
import { AuditAction, UserRole } from '../utils/enums';

import { AuditService } from './audit.service';

import { logger } from '@/config/logger';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: {
    id: string;
    email: string;
    name?: string;
    role: string;
  };
  tokens: TokenPair;
}

export class AuthService {
  static async signup(
    email: string,
    password: string,
    name: string,
    role?: string
  ): Promise<AuthResult> {
    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      const error: any = new Error('User with this email already exists');
      error.statusCode = 409;
      error.code = 'USER_ALREADY_EXISTS';
      throw error;
    }

    // Hash password
    const passwordHash = await this.hashPassword(password);

    // Create user with EMPLOYEE role by default unless provided
    const user = new User({
      email: email.toLowerCase(),
      passwordHash,
      name,
      role: role ?? 'EMPLOYEE',
      status: 'ACTIVE',
    });

    await user.save();

    // Generate tokens
    const tokens = this.generateTokens(user);

    // Audit log
    const userId = (user._id as mongoose.Types.ObjectId).toString();
    await AuditService.log(
      userId,
      'User',
      userId,
      AuditAction.CREATE
    );

    return {
      user: {
        id: userId,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      tokens,
    };
  }

  static async login(email: string, password: string): Promise<AuthResult> {
    const normalizedEmail = email.toLowerCase().trim();
    
    // Try to find user first
    const user = await User.findOne({ email: normalizedEmail });
    let companyAdmin: ICompanyAdmin | null = null;

    // If not found in User collection, check CompanyAdmin collection
    if (!user) {
      companyAdmin = await CompanyAdmin.findOne({ email: normalizedEmail });
    }

    if (!user && !companyAdmin) {
      logger.debug({ email: normalizedEmail }, 'Login attempt failed - User/Admin not found');
      const error: any = new Error('Invalid credentials');
      error.statusCode = 401;
      error.code = 'INVALID_CREDENTIALS';
      throw error;
    }

    // Check status
    if (user && user.status !== 'ACTIVE') {
      logger.debug({ email: normalizedEmail }, 'Login attempt failed - Account inactive');
      const error: any = new Error('Account is inactive');
      error.statusCode = 403;
      error.code = 'ACCOUNT_INACTIVE';
      throw error;
    }

    if (companyAdmin && companyAdmin.status !== CompanyAdminStatus.ACTIVE) {
      logger.debug({ email: normalizedEmail }, 'Login attempt failed - Company admin account inactive');
      const error: any = new Error('Account is inactive');
      error.statusCode = 403;
      error.code = 'ACCOUNT_INACTIVE';
      throw error;
    }

    // Verify password
    let isPasswordValid = false;
    if (user) {
      isPasswordValid = await user.comparePassword(password);
    } else if (companyAdmin) {
      isPasswordValid = await companyAdmin.comparePassword(password);
    }

    if (!isPasswordValid) {
      logger.debug({ email: normalizedEmail }, 'Login attempt failed - Invalid password');
      const error: any = new Error('Invalid credentials');
      error.statusCode = 401;
      error.code = 'INVALID_CREDENTIALS';
      throw error;
    }

    // Update last login and generate tokens
    if (user) {
      logger.info({ email: normalizedEmail, role: user.role }, 'Login successful');
      user.lastLoginAt = new Date();
      await user.save();

      const tokens = this.generateTokensForUser(user);
      const userId = (user._id as mongoose.Types.ObjectId).toString();

      await AuditService.log(
        userId,
        'User',
        userId,
        AuditAction.UPDATE,
        { lastLoginAt: user.lastLoginAt }
      );

      return {
        user: {
          id: userId,
          email: user.email,
          name: user.name,
          role: user.role,
          ...(user.companyId && { companyId: (user.companyId as mongoose.Types.ObjectId).toString() }),
        },
        tokens,
      };
    } else if (companyAdmin) {
      logger.info({ email: normalizedEmail, role: 'COMPANY_ADMIN' }, 'Login successful');
      companyAdmin.lastLoginAt = new Date();
      await companyAdmin.save();

      const tokens = this.generateTokensForCompanyAdmin(companyAdmin);
      const adminId = (companyAdmin._id as mongoose.Types.ObjectId).toString();

      await AuditService.log(
        adminId,
        'CompanyAdmin',
        adminId,
        AuditAction.UPDATE,
        { lastLoginAt: companyAdmin.lastLoginAt }
      );

      return {
        user: {
          id: adminId,
          email: companyAdmin.email,
          name: companyAdmin.name,
          role: UserRole.COMPANY_ADMIN,
        },
        tokens,
      };
    }

    // This should never happen, but TypeScript needs it
    const error: any = new Error('Invalid credentials');
    error.statusCode = 401;
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  static async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    try {
      const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret) as {
        id: string;
        email: string;
        role: string;
        companyId?: string;
      };

      // Check if it's a company admin based on role
      if (decoded.role === UserRole.COMPANY_ADMIN) {
        const companyAdmin = await CompanyAdmin.findById(decoded.id);
        if (!companyAdmin || companyAdmin.status !== CompanyAdminStatus.ACTIVE) {
          throw new Error('Company admin not found or inactive');
        }
        const accessToken = this.generateAccessTokenForCompanyAdmin(companyAdmin);
        return { accessToken };
      } else {
        // Regular user
        const user = await User.findById(decoded.id);
        if (!user || user.status !== 'ACTIVE') {
          throw new Error('User not found or inactive');
        }
        const accessToken = this.generateAccessTokenForUser(user);
        return { accessToken };
      }
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Refresh token expired');
      }
      throw new Error('Invalid refresh token');
    }
  }

  static generateTokens(user: IUser): TokenPair {
    return {
      accessToken: this.generateAccessToken(user),
      refreshToken: this.generateRefreshToken(user),
    };
  }

  static generateTokensForUser(user: IUser): TokenPair {
    return {
      accessToken: this.generateAccessTokenForUser(user),
      refreshToken: this.generateRefreshTokenForUser(user),
    };
  }

  static generateTokensForCompanyAdmin(admin: ICompanyAdmin): TokenPair {
    return {
      accessToken: this.generateAccessTokenForCompanyAdmin(admin),
      refreshToken: this.generateRefreshTokenForCompanyAdmin(admin),
    };
  }

  static generateAccessToken(user: IUser): string {
    return this.generateAccessTokenForUser(user);
  }

  static generateAccessTokenForUser(user: IUser): string {
    const userId = (user._id as mongoose.Types.ObjectId).toString();
    const payload: {
      id: string;
      email: string;
      role: string;
      companyId?: string;
    } = {
      id: userId,
      email: user.email,
      role: user.role,
    };
    if (user.companyId) {
      payload.companyId = (user.companyId as mongoose.Types.ObjectId).toString();
    }
    const secret = String(config.jwt.accessSecret);
    const options = {
      expiresIn: config.jwt.accessExpiresIn,
    } as jwt.SignOptions;
    return jwt.sign(payload, secret, options);
  }

  static generateAccessTokenForCompanyAdmin(admin: ICompanyAdmin): string {
    const adminId = (admin._id as mongoose.Types.ObjectId).toString();
    const payload = {
      id: adminId,
      email: admin.email,
      role: UserRole.COMPANY_ADMIN,
      companyId: (admin.companyId as mongoose.Types.ObjectId).toString(),
    };
    const secret = String(config.jwt.accessSecret);
    const options = {
      expiresIn: config.jwt.accessExpiresIn,
    } as jwt.SignOptions;
    return jwt.sign(payload, secret, options);
  }

  static generateRefreshToken(user: IUser): string {
    return this.generateRefreshTokenForUser(user);
  }

  static generateRefreshTokenForUser(user: IUser): string {
    const userId = (user._id as mongoose.Types.ObjectId).toString();
    const payload: {
      id: string;
      email: string;
      role: string;
      companyId?: string;
    } = {
      id: userId,
      email: user.email,
      role: user.role,
    };
    if (user.companyId) {
      payload.companyId = (user.companyId as mongoose.Types.ObjectId).toString();
    }
    const secret = String(config.jwt.refreshSecret);
    const options = {
      expiresIn: config.jwt.refreshExpiresIn,
    } as jwt.SignOptions;
    return jwt.sign(payload, secret, options);
  }

  static generateRefreshTokenForCompanyAdmin(admin: ICompanyAdmin): string {
    const adminId = (admin._id as mongoose.Types.ObjectId).toString();
    const payload = {
      id: adminId,
      email: admin.email,
      role: UserRole.COMPANY_ADMIN,
      companyId: (admin.companyId as mongoose.Types.ObjectId).toString(),
    };
    const secret = String(config.jwt.refreshSecret);
    const options = {
      expiresIn: config.jwt.refreshExpiresIn,
    } as jwt.SignOptions;
    return jwt.sign(payload, secret, options);
  }

  static async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }
}


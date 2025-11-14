import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';
import { config } from '../config/index';
import { logger } from '../utils/logger';
import { AuditService } from './audit.service';
import { AuditAction } from '../utils/enums';

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
    name: string
  ): Promise<AuthResult> {
    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      throw new Error('User with this email already exists');
    }

    // Hash password
    const passwordHash = await this.hashPassword(password);

    // Create user with EMPLOYEE role by default
    const user = new User({
      email: email.toLowerCase(),
      passwordHash,
      name,
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    });

    await user.save();

    // Generate tokens
    const tokens = this.generateTokens(user);

    // Audit log
    await AuditService.log(
      user._id.toString(),
      'User',
      user._id.toString(),
      AuditAction.CREATE
    );

    return {
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        role: user.role,
      },
      tokens,
    };
  }

  static async login(email: string, password: string): Promise<AuthResult> {
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      throw new Error('Invalid credentials');
    }

    if (user.status !== 'ACTIVE') {
      throw new Error('Account is inactive');
    }

    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      throw new Error('Invalid credentials');
    }

    // Update last login
    user.lastLoginAt = new Date();
    await user.save();

    // Generate tokens
    const tokens = this.generateTokens(user);

    // Audit log
    await AuditService.log(
      user._id.toString(),
      'User',
      user._id.toString(),
      AuditAction.UPDATE,
      { lastLoginAt: user.lastLoginAt }
    );

    return {
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        role: user.role,
      },
      tokens,
    };
  }

  static async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    try {
      const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret) as {
        id: string;
        email: string;
        role: string;
      };

      const user = await User.findById(decoded.id);

      if (!user || user.status !== 'ACTIVE') {
        throw new Error('User not found or inactive');
      }

      const accessToken = this.generateAccessToken(user);

      return { accessToken };
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

  static generateAccessToken(user: IUser): string {
    return jwt.sign(
      {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
      },
      config.jwt.accessSecret,
      {
        expiresIn: config.jwt.accessExpiresIn,
      }
    );
  }

  static generateRefreshToken(user: IUser): string {
    return jwt.sign(
      {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
      },
      config.jwt.refreshSecret,
      {
        expiresIn: config.jwt.refreshExpiresIn,
      }
    );
  }

  static async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }
}


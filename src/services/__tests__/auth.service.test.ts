import { AuthService } from '../auth.service';
import { User } from '../../models/User';
import bcrypt from 'bcrypt';

// Mock dependencies
jest.mock('../../models/User');
jest.mock('bcrypt');

describe('AuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('login', () => {
    it('should throw error if user not found', async () => {
      (User.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        AuthService.login('test@example.com', 'password')
      ).rejects.toThrow('Invalid credentials');
    });

    it('should throw error if password is invalid', async () => {
      const mockUser = {
        _id: '123',
        email: 'test@example.com',
        passwordHash: 'hashed',
        status: 'ACTIVE',
        role: 'EMPLOYEE',
        comparePassword: jest.fn().mockResolvedValue(false),
        save: jest.fn(),
        lastLoginAt: undefined,
      };

      (User.findOne as jest.Mock).mockResolvedValue(mockUser);

      await expect(
        AuthService.login('test@example.com', 'wrongpassword')
      ).rejects.toThrow('Invalid credentials');
    });

    it('should return user and tokens on successful login', async () => {
      const mockUser = {
        _id: '123',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: 'hashed',
        status: 'ACTIVE',
        role: 'EMPLOYEE',
        comparePassword: jest.fn().mockResolvedValue(true),
        save: jest.fn().mockResolvedValue(mockUser),
        lastLoginAt: undefined,
      };

      (User.findOne as jest.Mock).mockResolvedValue(mockUser);

      const result = await AuthService.login('test@example.com', 'password');

      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('tokens');
      expect(result.user.email).toBe('test@example.com');
      expect(result.tokens).toHaveProperty('accessToken');
      expect(result.tokens).toHaveProperty('refreshToken');
      expect(mockUser.save).toHaveBeenCalled();
    });
  });

  describe('hashPassword', () => {
    it('should hash password using bcrypt', async () => {
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed_password');

      const result = await AuthService.hashPassword('plainpassword');

      expect(bcrypt.hash).toHaveBeenCalledWith('plainpassword', 10);
      expect(result).toBe('hashed_password');
    });
  });
});


import { Server as HTTPServer } from 'http';

import jwt from 'jsonwebtoken';
import { Server as SocketIOServer, Socket } from 'socket.io';

import { config } from '../config/index';
import { UserRole } from '../utils/enums';

import { logger } from '@/config/logger';

interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

let io: SocketIOServer | null = null;

export const initializeSocketServer = (httpServer: HTTPServer): SocketIOServer => {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.app.env === 'development' ? true : [
        config.app.frontendUrlApp,
        config.app.frontendUrlAdmin,
      ],
      credentials: true,
      methods: ['GET', 'POST'],
    },
    path: '/socket.io',
  });

  // Authentication middleware for socket connections
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
      
      if (!token) {
        logger.warn('Socket connection attempt without token');
        return next(new Error('Authentication required'));
      }

      try {
        const decoded = jwt.verify(token, config.jwt.accessSecret) as {
          id: string;
          email: string;
          role: string;
        };

        socket.user = {
          id: decoded.id,
          email: decoded.email,
          role: decoded.role,
        };

        logger.debug(`Socket authenticated: ${decoded.email} (${decoded.id})`);
        next();
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          logger.warn('Socket connection with expired token');
          return next(new Error('Token expired'));
        }
        logger.warn({ error }, 'Socket connection with invalid token');
        return next(new Error('Invalid token'));
      }
    } catch (error) {
      logger.error({ error }, 'Socket authentication error');
      return next(new Error('Authentication failed'));
    }
  });

  io.on('connection', async (socket: AuthenticatedSocket) => {
    const user = socket.user;
    if (!user) {
      socket.disconnect();
      return;
    }

    logger.info(`Socket connected: ${user.email} (${user.id})`);

    // Join super admin room if user is super admin
    if (user.role === UserRole.SUPER_ADMIN) {
      socket.join('super-admin');
      logger.debug(`Super admin ${user.email} joined super-admin room`);
    }

    // Join company admin room if user is company admin
    if (user.role === UserRole.COMPANY_ADMIN) {
      try {
        // Get company ID from CompanyAdmin collection
        const { CompanyAdmin } = await import('../models/CompanyAdmin');
        const companyAdmin = await CompanyAdmin.findById(user.id).exec();
        if (companyAdmin && companyAdmin.companyId) {
          const companyId = companyAdmin.companyId.toString();
          socket.join(`company-admin:${companyId}`);
          logger.debug(`Company admin ${user.email} joined company-admin room: ${companyId}`);
        }
      } catch (error) {
        logger.error({ error, email: user.email }, 'Error joining company admin room');
      }
    }

    // Join manager room if user is a manager
    if (user.role === UserRole.MANAGER) {
      socket.join(`manager:${user.id}`);
      logger.debug(`Manager ${user.email} joined manager room: ${user.id}`);
    }

    // Join role-based room for role-based notifications (for Socket.IO UI refresh only)
    // Note: Firebase FCM topics are the primary delivery mechanism
    socket.join(`role:${user.role}`);
    logger.debug(`User ${user.email} joined role room: role:${user.role}`);

    // Join user room for employees (and all users) to receive real-time updates
    socket.join(`user:${user.id}`);
    logger.debug(`User ${user.email} joined user room: ${user.id}`);

    // Join company-specific room if user has a company
    // This can be extended based on your needs
    socket.on('join-company', (companyId: string) => {
      socket.join(`company:${companyId}`);
      logger.debug(`User ${user.email} joined company room: ${companyId}`);
    });

    // Leave company room
    socket.on('leave-company', (companyId: string) => {
      socket.leave(`company:${companyId}`);
      logger.debug(`User ${user.email} left company room: ${companyId}`);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      logger.info({ userId: user.id, email: user.email }, 'Socket disconnected');
    });

    // Error handling
    socket.on('error', (error) => {
      logger.error({ error, userId: user.id, email: user.email }, 'Socket error');
    });
  });

  logger.info('Socket.IO server initialized');
  return io;
};

export const getIO = (): SocketIOServer => {
  if (!io) {
    throw new Error('Socket.IO server not initialized. Call initializeSocketServer first.');
  }
  return io;
};

// Helper functions to emit events to specific rooms
export const emitToSuperAdmin = (event: string, data: any) => {
  if (io) {
    io.to('super-admin').emit(event, data);
    logger.debug(`Emitted ${event} to super-admin room`);
  }
};

export const emitToCompany = (companyId: string, event: string, data: any) => {
  if (io) {
    io.to(`company:${companyId}`).emit(event, data);
    logger.debug(`Emitted ${event} to company:${companyId}`);
  }
};

export const emitToAll = (event: string, data: any) => {
  if (io) {
    io.emit(event, data);
    logger.debug(`Emitted ${event} to all clients`);
  }
};


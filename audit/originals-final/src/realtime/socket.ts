import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { SOCKET_EVENTS } from '@moto/shared';
import { env, corsOrigins } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { AccessTokenPayload } from '../middleware/auth.js';

let io: Server | null = null;

export function initSocket(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: corsOrigins, credentials: true },
    path: '/socket.io',
  });

  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: string })?.token ?? (socket.handshake.headers.authorization?.toString().replace(/^Bearer /, '') || undefined);
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
      socket.data.userId = payload.sub;
      socket.data.branchId = payload.branchId;
      socket.data.role = payload.role;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join('global');
    socket.join(`branch:${socket.data.branchId}`);
    if (socket.data.role === 'admin' || socket.data.role === 'accountant') socket.join('all-branches');
    socket.on('join-branch', (branchId: string) => {
      if (typeof branchId === 'string' && (socket.data.role === 'admin' || socket.data.role === 'accountant')) socket.join(`branch:${branchId}`);
    });
    logger.debug({ user: socket.data.userId }, 'socket connected');
  });

  return io;
}

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

export function emitToBranch(branchId: string | null | undefined, event: SocketEvent, payload: unknown) {
  if (!io) return;
  io.to('all-branches').emit(event, payload);
  if (branchId) io.to(`branch:${branchId}`).emit(event, payload);
}

export function emitGlobal(event: SocketEvent, payload: unknown) {
  io?.to('global').emit(event, payload);
}

export function getIo() {
  return io;
}

/** Disconnects clients and releases the Socket.IO handles so the process can exit. */
export async function closeSocket() {
  if (!io) return;
  const instance = io;
  io = null;
  await new Promise<void>((resolve) => instance.close(() => resolve()));
}

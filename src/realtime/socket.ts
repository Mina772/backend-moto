import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { SOCKET_EVENTS } from '@moto/shared';
import { env, corsOrigins } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { loadAuthUser, type AccessTokenPayload } from '../middleware/auth.js';

let io: Server | null = null;
let revocationTimer: NodeJS.Timeout | null = null;

async function liveSocket(socket: Socket) {
  try {
    const auth = await authenticateSocketToken(socket.data.token);
    if (!socket.connected || auth.branchId !== socket.data.branchId || auth.role !== socket.data.role) throw new Error('socket scope changed');
    return auth;
  } catch { socket.disconnect(true); return null; }
}

export async function authenticateSocketToken(token: string) {
  const payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
  if (payload.typ !== 'access') throw new Error('unauthorized');
  const auth = await loadAuthUser(payload.sub);
  if (!auth || (payload.ver ?? 0) !== auth.authVersion) throw new Error('unauthorized');
  return auth;
}

export function initSocket(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: corsOrigins, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: string })?.token ?? (socket.handshake.headers.authorization?.toString().replace(/^Bearer /, '') || undefined);
    if (!token) return next(new Error('unauthorized'));
    try {
      const auth = await authenticateSocketToken(token);
      socket.data.userId = auth.id;
      socket.data.token = token;
      socket.data.branchId = auth.branchId;
      socket.data.role = auth.role;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join('global');
    socket.join(`branch:${socket.data.branchId}`);
    if (socket.data.role === 'admin' || socket.data.role === 'accountant') socket.join('all-branches');
    socket.on('join-branch', async (branchId: string) => {
      const auth = await liveSocket(socket);
      if (auth && typeof branchId === 'string' && branchId.length <= 256 && (auth.role === 'admin' || auth.role === 'accountant')) socket.join(`branch:${branchId}`);
    });
    logger.debug({ user: socket.data.userId }, 'socket connected');
  });

  revocationTimer = setInterval(() => { for (const socket of io?.sockets.sockets.values() ?? []) void liveSocket(socket); }, 5000);
  revocationTimer.unref();

  return io;
}

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

export function emitToBranch(branchId: string | null | undefined, event: SocketEvent, payload: unknown) {
  if (!io) return;
  const instance = io;
  for (const socket of instance.sockets.sockets.values()) {
    void liveSocket(socket).then(auth => {
      if (auth && instance === io && (auth.role === 'admin' || auth.role === 'accountant' || auth.branchId === branchId)) socket.emit(event, payload);
    });
  }
}

export function emitGlobal(event: SocketEvent, payload: unknown) {
  const instance = io;
  if (!instance) return;
  for (const socket of instance.sockets.sockets.values()) void liveSocket(socket).then(auth => { if (auth && instance === io) socket.emit(event, payload); });
}

export function getIo() {
  return io;
}

/** Disconnects clients and releases the Socket.IO handles so the process can exit. */
export async function closeSocket() {
  if (revocationTimer) clearInterval(revocationTimer);
  revocationTimer = null;
  if (!io) return;
  const instance = io;
  io = null;
  await new Promise<void>((resolve) => instance.close(() => resolve()));
}

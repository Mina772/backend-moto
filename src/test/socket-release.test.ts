import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { io as clientIo } from 'socket.io-client';
import type { Express } from 'express';
import { once } from 'node:events';
import { startTestDb, stopTestDb, loginAs } from './harness.js';
import { initSocket, closeSocket, emitToBranch } from '../realtime/socket.js';
import { UserModel } from '../db/models.js';
import { SOCKET_EVENTS } from '@moto/shared';
let app: Express, server: ReturnType<typeof createServer>, address: string;
beforeAll(async () => { app = await startTestDb({ seed: true }); server = createServer(app); initSocket(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); address = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterAll(async () => { await closeSocket(); await stopTestDb(); });
async function connect(token: string) {
  const socket = clientIo(address, { auth: { token }, transports: ['websocket'], reconnection: false });
  await new Promise<void>((resolve, reject) => { socket.on('connect', () => resolve()); socket.on('connect_error', reject); });
  return socket;
}
it('delivers a branch event once and disconnects a revoked connected administrator before further data', async () => {
  const login = await loginAs(app, 'admin'), socket = await connect(login.token); const events: unknown[] = [];
  socket.on(SOCKET_EVENTS.saleCreated, data => events.push(data));
  try {
    const first = new Promise<void>(resolve => socket.on(SOCKET_EVENTS.saleCreated, () => resolve()));
    emitToBranch('br-1', SOCKET_EVENTS.saleCreated, { marker: 'authorized' }); await first;
    expect(events).toHaveLength(1);
    await UserModel.updateOne({ _id: login.user.id }, { $inc: { authVersion: 1 } });
    const disconnected = new Promise<void>(resolve => socket.on('disconnect', () => resolve()));
    emitToBranch('br-1', SOCKET_EVENTS.saleCreated, { marker: 'revoked-secret' }); await disconnected;
    expect(events).toEqual([{ marker: 'authorized' }]);
  } finally { socket.disconnect(); }
});
it('disconnects an already connected user whose branch or role changed before accepting privileged joins', async () => {
  const login = await loginAs(app, 'khaled.m'), socket = await connect(login.token);
  try {
    const disconnected = new Promise<void>(resolve => socket.on('disconnect', () => resolve()));
    await UserModel.updateOne({ _id: login.user.id }, { $set: { branchId: 'br-2', role: 'cashier' } });
    socket.emit('join-branch', 'br-1'); await disconnected;
  } finally { socket.disconnect(); }
});

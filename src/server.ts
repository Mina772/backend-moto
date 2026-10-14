import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.js';
import { env, isProd } from './config/env.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { logger } from './lib/logger.js';
import { beginShutdown } from './lib/lifecycle.js';
import { closeSocket, initSocket } from './realtime/socket.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { ensureBootstrap } from './db/bootstrap.js';

async function main() {
  await connectDb();
  await ensureBootstrap();
  const app = createApp();
  const server = createServer(app);
  // keepAliveTimeout must exceed the load balancer's idle timeout, or the LB reuses a socket the server just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 120_000;
  initSocket(server);
  startJobs();
  await new Promise<void>((resolve) => server.listen(env.PORT, resolve));
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'API listening');

  let stopping = false;
  const shutdown = async (signal: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    beginShutdown();
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      stopJobs();
      // Keep serving while /api/health/ready reports draining so the LB can take us out of rotation.
      if (isProd && env.SHUTDOWN_DRAIN_MS > 0) await delay(env.SHUTDOWN_DRAIN_MS);
      await closeSocket();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await disconnectDb();
      logger.info('shutdown complete');
    } catch (e) {
      logger.error({ err: e }, 'error during shutdown');
      code = 1;
    }
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });
}

main().catch((e) => {
  logger.fatal({ err: e }, 'fatal startup error');
  process.exit(1);
});

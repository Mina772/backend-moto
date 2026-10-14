import cron, { type ScheduledTask } from 'node-cron';
import { isTest } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { runScheduledAlerts } from '../modules/alerts/engine.js';
import { snapshotDeadStock } from '../modules/reports/service.js';
import { BUSINESS_TIME_ZONE } from '../lib/businessTime.js';

const tasks: ScheduledTask[] = [];
let warmup: ReturnType<typeof setTimeout> | null = null;

export function startJobs() {
  if (isTest) return;
  if (tasks.length) return;
  tasks.push(
    cron.schedule('*/15 * * * *', async () => {
      await runScheduledAlerts().catch((e) => logger.warn({ err: e }, 'alerts job failed'));
    }, { noOverlap: true, timezone: BUSINESS_TIME_ZONE }),
  );
  tasks.push(
    cron.schedule('30 2 * * *', async () => {
      await snapshotDeadStock().catch((e) => logger.warn({ err: e }, 'dead-stock snapshot failed'));
    }, { noOverlap: true, timezone: BUSINESS_TIME_ZONE }),
  );
  // Warm-up pass shortly after boot.
  warmup = setTimeout(() => {
    warmup = null;
    runScheduledAlerts().catch((e) => logger.warn({ err: e }, 'alerts warmup failed'));
  }, 10_000);
  logger.info('cron jobs scheduled (alerts */15m, dead-stock 02:30)');
}

export function stopJobs() {
  if (warmup) clearTimeout(warmup);
  warmup = null;
  for (const t of tasks) void t.destroy();
  tasks.length = 0;
}

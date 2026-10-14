import { randomBytes, randomUUID } from 'node:crypto';

/** Short, URL-safe, time-sortable id with a readable prefix (e.g. `sale-m1x2k9ab3c`). */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex');
  return `${prefix}-${time}${rand}`;
}

export const uuid = () => randomUUID();

export const nowISO = () => new Date().toISOString();

/** Deterministic pseudo-random generator so mock data is stable across reloads. */
export function createRng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    chance: (p: number) => next() < p,
    shuffle: <T>(arr: readonly T[]): T[] => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}

export const rng = createRng(20260101);

const NOW = new Date('2026-10-03T14:30:00');
export const MOCK_NOW = NOW;

export function daysAgo(days: number, hour = 10, minute = 0): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

export function daysFromNow(days: number): string {
  return daysAgo(-days);
}

export function randomDateWithin(days: number): string {
  return daysAgo(rng.int(0, days), rng.int(8, 21), rng.int(0, 59));
}

export function pad(n: number, len = 4): string {
  return String(n).padStart(len, '0');
}

import { readdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Express } from 'express';

const uploadDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { default: path } = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'moto-audit-uploads-'));
  process.env.UPLOAD_DIR = dir;
  return dir;
});
import { api, loginAs, startTestDb, stopTestDb } from './harness.js';

let app: Express;
let token: string;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZt8AAAAASUVORK5CYII=', 'base64');
const upload = (body: Buffer, filename: string, contentType: string) => api(app).post('/api/settings/logo').set('Authorization', `Bearer ${token}`).attach('file', body, { filename, contentType });

beforeAll(async () => {
  app = await startTestDb({ seed: true });
  token = (await loginAs(app, 'admin')).token;
});
afterAll(async () => {
  await stopTestDb();
  rmSync(uploadDir, { recursive: true, force: true });
});

it('rejects HTML masquerading as a PNG without storing or changing the logo', async () => {
  const before = (await api(app).get('/api/settings').set('Authorization', `Bearer ${token}`)).body.company.logoUrl;
  const files = readdirSync(uploadDir);
  const response = await upload(Buffer.from('<html><script>alert(1)</script></html>'), 'logo.html', 'image/png');
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_IMAGE');
  expect(readdirSync(uploadDir)).toEqual(files);
  expect((await api(app).get('/api/settings').set('Authorization', `Bearer ${token}`)).body.company.logoUrl).toBe(before);
});

it('stores a valid PNG with a canonical generated extension regardless of the submitted filename', async () => {
  const response = await upload(png, 'logo.html', 'image/png');
  expect(response.status).toBe(200);
  expect(response.body.url).toMatch(/^\/uploads\/logo-[a-f0-9-]+\.png$/);
  const served = await api(app).get(response.body.url);
  expect(served.status).toBe(200);
  expect(served.headers['content-type']).toMatch(/^image\/png/);
  expect(served.body).toEqual(png);
});

it('rejects a declared image type that does not match the bytes', async () => {
  const response = await upload(png, 'logo.jpg', 'image/jpeg');
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_IMAGE');
});

it('rejects active SVG uploads', async () => {
  const response = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg', 'image/svg+xml');
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('BAD_MIME');
});

it('returns a client error for images larger than the upload limit', async () => {
  const files = readdirSync(uploadDir);
  const response = await upload(Buffer.alloc(2 * 1024 * 1024 + 1), 'large.png', 'image/png');
  expect(response.status).toBe(413);
  expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  expect(readdirSync(uploadDir)).toEqual(files);
});

it('rejects logo uploads without settings permission', async () => {
  const cashier = await loginAs(app, 'cashier1');
  const response = await api(app).post('/api/settings/logo').set('Authorization', `Bearer ${cashier.token}`).attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
  expect(response.status).toBe(403);
});

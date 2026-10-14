import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { api, loginAs, startTestDb, stopTestDb } from './harness.js';
import { PurchaseModel } from '../db/models.js';
let app: Express; let token: string;
beforeAll(async () => { app = await startTestDb({ seed: true }); token = (await loginAs(app, 'admin')).token; });
afterAll(stopTestDb);
const create = (branchId: string, number: string, supplierId = 'sup-1') => api(app).post('/api/purchases').set('Authorization', `Bearer ${token}`).send({ branchId, warehouseId: branchId === 'br-1' ? 'wh-1' : 'wh-3', supplierId, supplierInvoiceNumber: number, items: [{ productId: 'prod-1', quantity: 1, unitCost: 10 }] });
it('serializes duplicate supplier invoice submissions across branches while permitting another supplier', async () => {
  const responses = await Promise.all([create('br-1', ' SYNTHETIC-UNIQUE '), create('br-2', 'SYNTHETIC-UNIQUE')]);
  expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
  expect(responses.find(r => r.status === 409)!.body.error.code).toBe('SUPPLIER_INVOICE_EXISTS');
  expect(await PurchaseModel.countDocuments({ supplierId: 'sup-1', supplierInvoiceNumber: 'SYNTHETIC-UNIQUE' })).toBe(1);
  expect((await create('br-2', 'SYNTHETIC-UNIQUE', 'sup-2')).status).toBe(201);
});
it('allows multiple missing supplier numbers without conflating them', async () => {
  expect((await create('br-1', '')).status).toBe(201); expect((await create('br-1', '')).status).toBe(201);
});

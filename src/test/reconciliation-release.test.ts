import { afterAll, beforeAll, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import { startTestDb, stopTestDb } from './harness.js';
import { reconciliationPlan } from '../db/reconciliation-plan.js';
beforeAll(async () => { await startTestDb(); });
afterAll(stopTestDb);
it('detects source mismatches, company-wide duplicates, orphan debt and missing reimbursement without modifying history', async () => {
  // Separate owned fixture DB avoids application indexes on deliberately malformed records.
  const db = mongoose.connection.getClient().db('moto-release-reconciliation-fixture') as unknown as Db;
  await db.collection('purchases').insertMany([{ _id: 'p1' as never, supplierId: 's1', supplierInvoiceNumber: ' DUP ', total: 100, paid: 50, remaining: 0, status: 'received' }, { _id: 'p2' as never, supplierId: 's1', supplierInvoiceNumber: 'dup', total: 100, paid: 0, remaining: 100, status: 'ordered' }]);
  await db.collection('purchasereturns').insertOne({ _id: 'r1' as never, purchaseId: 'p1', total: 100, debtReduction: 50, payoutAmount: 50 });
  await db.collection('customerdebts').insertOne({ _id: 'orphan' as never, saleId: 'missing', remaining: 10.001 });
  const before = await db.collection('purchases').find().toArray(), plan = await reconciliationPlan(db);
  expect(plan.issues.map(i => i.code)).toEqual(expect.arrayContaining(['PURCHASE_RECEIPTS_PAID_MISMATCH', 'COMPANY_SUPPLIER_INVOICE_DUPLICATE', 'SUPPLIER_RECEIVABLE_EVIDENCE_MISSING', 'ORPHAN_CUSTOMER_DEBT', 'FINANCIAL_PRECISION_REVIEW']));
  expect(plan.issues.some(i => i.code === 'PURCHASE_REMAINING_SOURCE_MISMATCH')).toBe(false); expect(plan.mutationCount).toBe(0);
  expect(await db.collection('purchases').find().toArray()).toEqual(before);
});

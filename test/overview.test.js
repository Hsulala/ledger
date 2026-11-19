import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, getDb, purchaseBody, seedStore } from './helpers/app.js';

async function setup() {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const b = await seedStore(env, { id: 'beta', name: '乙店' });
  const [c1, c2] = [a.companyIds['翔慧'], a.companyIds['翔媁']];
  const make = async (store, co, body, confirm) => {
    const r = await call(env, 'POST', `/api/c/${co}/purchases`, { cookie: store.cookie, body });
    assert.equal(r.status, 201);
    if (confirm) assert.equal((await call(env, 'POST', `/api/c/${co}/purchases/${r.data.id}/confirm`, { cookie: store.cookie, body: { acknowledge_duplicate: true } })).status, 200);
    return r.data.id;
  };
  // 甲店：翔慧 11 月兩張入帳（34,500 與 300）、一張草稿；翔媁 11 月一張入帳；10 月一張入帳
  await make(a, c1, purchaseBody(a, { vendor_doc_no: 'N1' }), true);
  await make(a, c1, purchaseBody(a, { vendor_doc_no: 'N2', items: [{ line_type: 'freight', raw_name: '運費', amount: 300 }] }), true);
  await make(a, c1, purchaseBody(a, { vendor_doc_no: 'N3' }), false);
  await make(a, c2, purchaseBody(a, { vendor_doc_no: 'N4', items: [{ line_type: 'freight', raw_name: '運費', amount: 1000 }] }), true);
  await make(a, c1, purchaseBody(a, { vendor_doc_no: 'O1', doc_date: '2026-10-05', items: [{ line_type: 'freight', raw_name: '運費', amount: 50 }] }), true);
  // 乙店有自己的資料，不能出現在甲店的總覽
  await make(b, b.companyIds['翔慧'], purchaseBody(b, { vendor_doc_no: 'B1' }), true);
  return { env, a, b, c1, c2 };
}

test('總覽：依買方公司彙總本月已入帳與草稿，並有跨公司合計；別家店的資料不計入', async () => {
  const { env, a, b, c1, c2 } = await setup();
  const res = await call(env, 'GET', '/api/overview?month=2026-11', { cookie: a.cookie });
  assert.equal(res.status, 200);
  const p1 = res.data.purchases.find((r) => r.company_id === c1);
  const p2 = res.data.purchases.find((r) => r.company_id === c2);
  assert.deepEqual({ drafts: p1.drafts, count: p1.month_count, amount: p1.month_amount }, { drafts: 1, count: 2, amount: 34800 });
  assert.deepEqual({ drafts: p2.drafts, count: p2.month_count, amount: p2.month_amount }, { drafts: 0, count: 1, amount: 1000 });
  assert.equal(res.data.purchases.length, 2);
  assert.equal(res.data.top_vendors[0].amount, 35800);
  assert.equal(res.data.top_vendors[0].count, 3);
  assert.equal(res.data.recent.length, 4); // 本店已入帳共 4 張（草稿不算）
  assert.ok(res.data.recent.every((r) => [c1, c2].includes(r.company_id)));
  const other = await call(env, 'GET', '/api/overview?month=2026-11', { cookie: b.cookie });
  assert.equal(other.data.purchases.length, 1);
  assert.equal(other.data.purchases[0].month_amount, 34500);
});

test('總覽與跨公司清單：月份格式、模組、登入檢查；清單含兩家公司且只限本店', async () => {
  const { env, a, b } = await setup();
  assert.equal((await call(env, 'GET', '/api/overview?month=2026-13', { cookie: a.cookie })).status, 400);
  assert.equal((await call(env, 'GET', '/api/overview', { cookie: a.cookie })).status, 400);
  assert.equal((await call(env, 'GET', '/api/overview?month=2026-11')).status, 401);
  assert.equal((await call(env, 'GET', '/api/all/purchases')).status, 401);
  const all = await call(env, 'GET', '/api/all/purchases', { cookie: a.cookie });
  assert.equal(all.data.total, 5); // 4 張入帳 + 1 張草稿
  assert.equal(new Set(all.data.rows.map((r) => r.company_id)).size, 2);
  assert.ok(!all.data.rows.some((r) => r.vendor_doc_no === 'B1'));
  const draftsOnly = await call(env, 'GET', '/api/all/purchases?status=draft', { cookie: a.cookie });
  assert.equal(draftsOnly.data.total, 1);
  assert.equal((await call(env, 'GET', '/api/all/orders', { cookie: b.cookie })).data.total, 0);
  await getDb(env).system.setModules('alpha', { purchaseOrders: false });
  assert.equal((await call(env, 'GET', '/api/overview?month=2026-11', { cookie: a.cookie })).status, 403);
  assert.equal((await call(env, 'GET', '/api/all/purchases', { cookie: a.cookie })).status, 403);
});

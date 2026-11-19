import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, seedStore } from './helpers/app.js';
import { buildStatement, dayBefore, periodOf, taxOf } from '../src/statement/calc.js';

test('稅額：0.5 進位、每張單各自算（對照 Mamie 的對帳單：7,650→383、2,075→104、5,390→270）', () => {
  assert.equal(taxOf(7650, 5), 383);
  assert.equal(taxOf(2075, 5), 104);
  assert.equal(taxOf(5390, 5), 270);
  assert.equal(taxOf(30600, 5), 1530);
  assert.equal(taxOf(5100, 5), 255);
  assert.equal(taxOf(6000, 0), 0);
  assert.equal(taxOf(0, 5), 0);
});

test('結帳區間：日曆月與每月 25 日結帳', () => {
  assert.deepEqual(periodOf('2026-10', null), { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(periodOf('2026-02', 0), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(periodOf('2026-10', 25), { start: '2026-09-26', end: '2026-10-25' }); // 嘉佩樂
  assert.deepEqual(periodOf('2026-02', 25), { start: '2026-01-26', end: '2026-02-25' }); // 岩漿
  assert.deepEqual(periodOf('2026-01', 25), { start: '2025-12-26', end: '2026-01-25' });
  assert.equal(dayBefore('2026-03-01'), '2026-02-28');
});

const doc = (no, date, amount, rate) => ({ id: no, sales_no: no, doc_date: date, amount, tax: taxOf(amount, rate) });

test('對照嘉佩樂對帳單（2026/09/26～10/25）：金額 9,725、稅額 487、應收 10,212', () => {
  const st = buildStatement({ docs: [doc('20261013010', '2026-10-13', 7650, 5), doc('20261014007', '2026-10-14', 2075, 5)], opening: null, payments: [], start: '2026-09-26', end: '2026-10-25' });
  assert.deepEqual(st.rows.map((r) => [r.amount, r.tax, r.receivable]), [[7650, 383, 8033], [2075, 104, 2179]]);
  assert.deepEqual(st.totals, { amount: 9725, tax: 487, receivable: 10212, paid: 0 });
  assert.equal(st.prev_balance, 0);
  assert.equal(st.grand_unpaid, 10212);
});

test('對照岩漿火鍋對帳單（2026/01/26～02/25）：前期 43,082，本期應收 53,855，總應收 96,937', () => {
  const docs = [doc('20260130006', '2026-01-30', 30600, 5), doc('20260202012', '2026-02-02', 5100, 5), doc('20260202024', '2026-02-02', 5100, 5), doc('20260203018', '2026-02-03', 5100, 5), doc('20260204002', '2026-02-04', 5390, 5)];
  const st = buildStatement({ docs, opening: { as_of: '2026-01-25', amount: 43082 }, payments: [], start: '2026-01-26', end: '2026-02-25' });
  assert.equal(st.prev_balance, 43082);
  assert.deepEqual(st.totals, { amount: 51290, tax: 2565, receivable: 53855, paid: 0 });
  assert.equal(st.grand_unpaid, 96937);
  assert.equal(st.prepaid, 0);
});

test('收款先進先出：先沖期初與最早的單，期內收款可以沖前期，超過的記為預收', () => {
  const docs = [doc('A', '2026-01-05', 500, 0), doc('B', '2026-02-03', 500, 0)];
  const base = { docs, opening: { as_of: '2025-12-31', amount: 1000 }, start: '2026-02-01', end: '2026-02-28' };
  const st = buildStatement({ ...base, payments: [{ paid_on: '2026-01-20', amount: 700 }, { paid_on: '2026-02-10', amount: 400 }] });
  assert.equal(st.prev_balance, 800);          // 期初 1000 + A 500 - 本期開始前已收 700
  assert.equal(st.prev_paid_in_period, 400);    // 期內收到的 400 沖掉前期
  assert.deepEqual(st.rows.map((r) => [r.sales_no, r.paid, r.unpaid]), [['B', 0, 500]]);
  assert.equal(st.grand_unpaid, 900);           // 2000 - 1100
  assert.equal(st.prepaid, 0);
  const over = buildStatement({ ...base, payments: [{ paid_on: '2026-02-10', amount: 2500 }] });
  assert.equal(over.grand_unpaid, 0);
  assert.equal(over.prepaid, 500);
  assert.deepEqual(over.rows.map((r) => r.paid), [500]);
  // 期內沒有單據、但還有欠款，也算出總應收
  const none = buildStatement({ docs: [], opening: { as_of: '2025-12-31', amount: 300 }, payments: [], start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual([none.rows.length, none.prev_balance, none.grand_unpaid], [0, 300, 300]);
});

// ---------- API ----------
async function setup() {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const b = await seedStore(env, { id: 'beta', name: '乙店' });
  const admin = (await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } })).cookie;
  for (const id of ['alpha', 'beta']) await call(env, 'PUT', `/api/admin/stores/${id}/modules`, { cookie: admin, body: { modules: { customerStatements: true } } });
  const s = a.scope;
  const now = new Date().toISOString();
  const head = await s.create('customers', { code: 'D02', name: '瑞哥雞肉飯', tax_rate_pct: 5, billing_day: 25, created_at: now });
  const shop = await s.create('customers', { code: 'ML1', name: '瑞哥信義店', bill_to_name: '瑞哥雞肉飯', created_at: now });
  const shop2 = await s.create('customers', { code: 'ML2', name: '瑞哥南京店', bill_to_name: '瑞哥雞肉飯', created_at: now });
  const other = await s.create('customers', { code: 'X1', name: '別的客戶', created_at: now });
  return { env, a, b, admin, head, shop, shop2, other, c1: a.companyIds['翔慧'], c2: a.companyIds['翔媁'] };
}
async function order(t, co, customer, no, date, amount, { confirm = true } = {}) {
  const body = { customer_id: customer, sales_no: no, doc_date: date, items: [{ line_type: 'product', raw_name: '烤雞醬', qty: 1, unit: '箱', unit_price_x100: amount * 100, amount }] };
  const r = await call(t.env, 'POST', `/api/c/${co}/orders`, { cookie: t.a.cookie, body });
  assert.equal(r.status, 201);
  if (confirm) assert.equal((await call(t.env, 'POST', `/api/c/${co}/orders/${r.data.id}/confirm`, { cookie: t.a.cookie, body: { acknowledge_duplicate: true } })).status, 200);
  return r.data.id;
}
const get = (t, co, q, cookie = t.a.cookie) => call(t.env, 'GET', `/api/c/${co}/statement?${q}`, { cookie });

test('對帳單 API：分店歸在請款客戶底下、依結帳日取區間、稅率照請款客戶、只算已入帳、備註分店名', async () => {
  const t = await setup();
  await order(t, t.c1, t.shop, '20261013010', '2026-10-13', 7650);
  await order(t, t.c1, t.shop2, '20261014007', '2026-10-14', 2075);
  await order(t, t.c1, t.shop, 'IN-NOV', '2026-10-26', 999);              // 超過 25 日，不在本期
  await order(t, t.c1, t.shop, 'DRAFT', '2026-10-15', 5000, { confirm: false }); // 草稿不算
  await order(t, t.c2, t.shop, 'OTHER-CO', '2026-10-15', 4000);            // 另一家買方公司不算
  await order(t, t.c1, t.other, 'NOT-MINE', '2026-10-15', 3000);           // 不同請款客戶不算
  // 從分店點進去也會落在請款客戶的對帳單
  for (const id of [t.head, t.shop]) {
    const r = await get(t, t.c1, `customer_id=${id}&month=2026-10`);
    assert.equal(r.status, 200);
    assert.equal(r.data.customer.name, '瑞哥雞肉飯');
    assert.deepEqual([r.data.start, r.data.end], ['2026-09-26', '2026-10-25']);
    assert.deepEqual(r.data.rows.map((x) => [x.sales_no, x.amount, x.tax, x.receivable]), [['20261013010', 7650, 383, 8033], ['20261014007', 2075, 104, 2179]]);
    assert.deepEqual(r.data.rows.map((x) => x.shop), ['瑞哥信義店', '瑞哥南京店']);
    assert.equal(r.data.rows[0].items[0].raw_name, '烤雞醬');
    assert.equal(r.data.totals.receivable, 10212);
    assert.equal(r.data.grand_unpaid, 10212);
    assert.equal(r.data.company.name, '翔慧');
  }
  const nov = await get(t, t.c1, `customer_id=${t.head}&month=2026-11`);
  assert.deepEqual(nov.data.rows.map((x) => x.sales_no), ['IN-NOV']);
  assert.equal(nov.data.prev_balance, 10212);       // 10 月沒收到款，成為 11 月的前期
  assert.equal(nov.data.grand_unpaid, 10212 + 999 + 50); // 999 的稅 50
});

test('收款登錄、期初餘額、清單、刪除；驗證與權限', async () => {
  const t = await setup();
  await order(t, t.c1, t.shop, 'N1', '2026-10-13', 1000);
  const pay = (body, cookie = t.a.cookie) => call(t.env, 'POST', `/api/c/${t.c1}/customer-payments`, { cookie, body });
  assert.equal((await pay({ customer_id: 'nope', paid_on: '2026-10-20', amount: 100 })).status, 400);
  assert.equal((await pay({ customer_id: t.shop, paid_on: '10/20', amount: 100 })).status, 400);
  assert.equal((await pay({ customer_id: t.shop, paid_on: '2026-10-20', amount: -5 })).status, 400);
  assert.equal((await pay({ customer_id: t.shop, paid_on: '2026-10-20', amount: 12.5 })).status, 400);
  assert.equal((await pay({ customer_id: t.shop, paid_on: '2026-10-20' })).status, 400);
  // 從分店登錄的收款，記在請款客戶的帳上
  const ok = await pay({ customer_id: t.shop, paid_on: '2026-10-20', amount: 600, method: '匯款' });
  assert.equal(ok.status, 201);
  const r = await get(t, t.c1, `customer_id=${t.head}&month=2026-10`);
  assert.deepEqual([r.data.rows[0].paid, r.data.rows[0].unpaid, r.data.grand_unpaid], [600, 450, 450]); // 1000 + 稅 50 - 600
  // 期初餘額
  const open = (body, cookie = t.a.cookie) => call(t.env, 'PUT', `/api/c/${t.c1}/customer-opening`, { cookie, body });
  assert.equal((await open({ customer_id: t.head, as_of: '2026-09-25', amount: 43082 })).status, 200);
  assert.equal((await open({ customer_id: t.head, as_of: 'x', amount: 1 })).status, 400);
  const r2 = await get(t, t.c1, `customer_id=${t.head}&month=2026-10`);
  assert.equal(r2.data.prev_balance, 43082 - 0); // 期初在本期開始前、收款在期內
  assert.equal(r2.data.grand_unpaid, 43082 + 1050 - 600);
  // 清單
  const list = await call(t.env, 'GET', `/api/c/${t.c1}/statements?month=2026-10`, { cookie: t.a.cookie });
  assert.equal(list.data.rows.length, 1);
  assert.deepEqual([list.data.rows[0].name, list.data.rows[0].doc_count, list.data.rows[0].grand_unpaid], ['瑞哥雞肉飯', 1, 43082 + 1050 - 600]);
  // 別家店看不到；未開通模組不能用；壞月份 400
  assert.equal((await call(t.env, 'GET', `/api/c/${t.c1}/statements?month=2026-10`, { cookie: t.b.cookie })).status, 404);
  assert.equal((await call(t.env, 'GET', `/api/c/${t.c1}/statements?month=2026-13`, { cookie: t.a.cookie })).status, 400);
  await call(t.env, 'PUT', '/api/admin/stores/alpha/modules', { cookie: t.admin, body: { modules: { customerStatements: false } } });
  assert.equal((await call(t.env, 'GET', `/api/c/${t.c1}/statements?month=2026-10`, { cookie: t.a.cookie })).status, 403);
  await call(t.env, 'PUT', '/api/admin/stores/alpha/modules', { cookie: t.admin, body: { modules: { customerStatements: true } } });
  // 刪除收款：負責人可以，結果回到沒收款
  assert.equal((await call(t.env, 'DELETE', `/api/c/${t.c1}/customer-payments/${ok.data.id}`, { cookie: t.a.cookie })).status, 200);
  assert.equal((await get(t, t.c1, `customer_id=${t.head}&month=2026-10`)).data.rows[0].paid, 0);
});

test('結帳日與稅率可從客戶主檔設定，並有範圍檢查', async () => {
  const t = await setup();
  const put = (body) => call(t.env, 'PUT', `/api/master/customers/${t.other}`, { cookie: t.a.cookie, body });
  assert.equal((await put({ billing_day: 29 })).status, 400);
  assert.equal((await put({ tax_rate_pct: 30 })).status, 400);
  assert.equal((await put({ billing_day: 20, tax_rate_pct: 5 })).status, 200);
  const row = (await call(t.env, 'GET', '/api/master/customers', { cookie: t.a.cookie })).data.rows.find((r) => r.id === t.other);
  assert.deepEqual([row.billing_day, row.tax_rate_pct], [20, 5]);
  assert.equal((await put({ billing_day: null })).status, 200);
});

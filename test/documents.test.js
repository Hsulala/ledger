import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, purchaseBody, seedStore } from './helpers/app.js';

async function setup() {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  return { env, a, co: a.companyIds['翔慧'], other: a.companyIds['翔媁'] };
}

test('手動輸入一張進貨單：建立草稿、修改、確認入帳、清單與搜尋', async () => {
  const { env, a, co } = await setup();
  const created = await call(env, 'POST', `/api/c/${co}/purchases`, { cookie: a.cookie, body: purchaseBody(a) });
  assert.equal(created.status, 201);
  const id = created.data.id;

  // 合計由程式加總：34200 + 300
  let doc = (await call(env, 'GET', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie })).data;
  assert.equal(doc.status, 'draft');
  assert.equal(doc.total_amount, 34500);
  assert.equal(doc.items.length, 2);
  assert.equal(doc.items[1].line_type, 'freight');

  // 草稿可修改
  const edited = purchaseBody(a, { note: '補充', items: [{ line_type: 'product', raw_name: '辣鳳', product_id: a.product, cases: 40, packs: 1200, amount: 38000 }] });
  assert.equal((await call(env, 'PUT', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie, body: edited })).status, 200);
  doc = (await call(env, 'GET', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie })).data;
  assert.equal(doc.total_amount, 38000);
  assert.equal(doc.items.length, 1);

  // 確認入帳
  const ok = await call(env, 'POST', `/api/c/${co}/purchases/${id}/confirm`, { cookie: a.cookie, body: {} });
  assert.equal(ok.status, 200);
  doc = (await call(env, 'GET', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie })).data;
  assert.equal(doc.status, 'confirmed');
  assert.ok(doc.confirmed_at && doc.confirmed_by);

  // 已確認不能再改、不能再確認
  assert.equal((await call(env, 'PUT', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie, body: edited })).status, 409);
  assert.equal((await call(env, 'POST', `/api/c/${co}/purchases/${id}/confirm`, { cookie: a.cookie, body: {} })).status, 409);

  // 稽核紀錄：建立、修改、確認各一筆
  const actions = env.DB.raw.prepare("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY at").all(id).map((r) => r.action);
  assert.deepEqual(actions.sort(), ['purchase.confirm', 'purchase.create', 'purchase.update']);

  // 清單篩選與搜尋（單號、品項名稱）
  const byStatus = (await call(env, 'GET', `/api/c/${co}/purchases?status=confirmed`, { cookie: a.cookie })).data;
  assert.equal(byStatus.total, 1);
  assert.equal((await call(env, 'GET', `/api/c/${co}/purchases?q=S-00`, { cookie: a.cookie })).data.total, 1);
  assert.equal((await call(env, 'GET', `/api/c/${co}/purchases?q=辣鳳`, { cookie: a.cookie })).data.total, 1);
  assert.equal((await call(env, 'GET', `/api/c/${co}/purchases?q=不存在`, { cookie: a.cookie })).data.total, 0);
  assert.equal((await call(env, 'GET', `/api/c/${co}/purchases?from=2026-12-01`, { cookie: a.cookie })).data.total, 0);
});

test('確認入帳中途失敗：整筆回復，單據仍是草稿，沒有半筆資料', async () => {
  const { env, a, co } = await setup();
  const id = (await call(env, 'POST', `/api/c/${co}/purchases`, { cookie: a.cookie, body: purchaseBody(a) })).data.id;
  // 讓稽核紀錄寫入失敗（模擬確認過程中的任何一步出錯）
  env.DB.raw.exec("CREATE TRIGGER boom BEFORE INSERT ON audit_log WHEN NEW.action = 'purchase.confirm' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const failed = await call(env, 'POST', `/api/c/${co}/purchases/${id}/confirm`, { cookie: a.cookie, body: {} });
  assert.equal(failed.status, 500);
  const doc = (await call(env, 'GET', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie })).data;
  assert.equal(doc.status, 'draft');
  assert.equal(doc.confirmed_at, null);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'purchase.confirm'").get().n, 0);
  // 移除故障後可以正常確認
  env.DB.raw.exec('DROP TRIGGER boom');
  assert.equal((await call(env, 'POST', `/api/c/${co}/purchases/${id}/confirm`, { cookie: a.cookie, body: {} })).status, 200);
});

test('儲存草稿中途失敗：舊品項保留，不會留下只刪不補的半筆', async () => {
  const { env, a, co } = await setup();
  const id = (await call(env, 'POST', `/api/c/${co}/purchases`, { cookie: a.cookie, body: purchaseBody(a) })).data.id;
  env.DB.raw.exec("CREATE TRIGGER boom2 BEFORE INSERT ON audit_log WHEN NEW.action = 'purchase.update' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const failed = await call(env, 'PUT', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie, body: purchaseBody(a, { items: [{ raw_name: '新品', amount: 1 }] }) });
  assert.equal(failed.status, 500);
  const doc = (await call(env, 'GET', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie })).data;
  assert.equal(doc.items.length, 2);
  assert.equal(doc.total_amount, 34500);
});

test('重複單號：同廠商同單號要提醒，Mamie 明確同意才能入帳（跨公司也提醒）', async () => {
  const { env, a, co, other } = await setup();
  const first = (await call(env, 'POST', `/api/c/${co}/purchases`, { cookie: a.cookie, body: purchaseBody(a) })).data.id;
  assert.equal((await call(env, 'POST', `/api/c/${co}/purchases/${first}/confirm`, { cookie: a.cookie, body: {} })).status, 200);

  const dup = (await call(env, 'POST', `/api/c/${other}/purchases`, { cookie: a.cookie, body: purchaseBody(a) })).data.id;
  const warn = await call(env, 'POST', `/api/c/${other}/purchases/${dup}/confirm`, { cookie: a.cookie, body: {} });
  assert.equal(warn.status, 409);
  assert.equal(warn.data.duplicates.length, 1);
  assert.equal((await call(env, 'GET', `/api/c/${other}/purchases/${dup}`, { cookie: a.cookie })).data.status, 'draft');
  const agreed = await call(env, 'POST', `/api/c/${other}/purchases/${dup}/confirm`, { cookie: a.cookie, body: { acknowledge_duplicate: true } });
  assert.equal(agreed.status, 200);

  // 同品項同數量同金額、但單號不同 → 不算重複
  const same = (await call(env, 'POST', `/api/c/${co}/purchases`, { cookie: a.cookie, body: purchaseBody(a, { vendor_doc_no: 'S-002' }) })).data.id;
  assert.equal((await call(env, 'POST', `/api/c/${co}/purchases/${same}/confirm`, { cookie: a.cookie, body: {} })).status, 200);
});

test('驗證：日期格式、品項、整數、缺必填；標黃欄位未確認不能入帳', async () => {
  const { env, a, co } = await setup();
  const post = (body) => call(env, 'POST', `/api/c/${co}/purchases`, { cookie: a.cookie, body });
  assert.equal((await post(purchaseBody(a, { doc_date: '115/11/10' }))).status, 400);
  assert.equal((await post(purchaseBody(a, { doc_date: '2026-02-30' }))).status, 400);
  assert.equal((await post(purchaseBody(a, { doc_type: 'bogus' }))).status, 400);
  assert.equal((await post(purchaseBody(a, { items: [{ raw_name: '', amount: 1 }] }))).status, 400);
  assert.equal((await post(purchaseBody(a, { items: [{ raw_name: 'x', amount: 1.5 }] }))).status, 400);
  const bad = await post(purchaseBody(a, { items: [{ raw_name: 'x', amount: 'abc' }] }));
  assert.ok(bad.data.fields['items.0.amount']);

  // 草稿可以沒有日期與品項，但不能入帳
  const draft = (await post({ vendor_id: a.vendor, doc_type: 'delivery' })).data.id;
  const refused = await call(env, 'POST', `/api/c/${co}/purchases/${draft}/confirm`, { cookie: a.cookie, body: {} });
  assert.equal(refused.status, 400);
  assert.ok(refused.data.fields.doc_date);

  // 標黃欄位（flags）還在 → 不能入帳；清掉後可以
  const flagged = (await post(purchaseBody(a, { vendor_doc_no: 'F-1', flags: { doc_date: true } }))).data.id;
  assert.equal((await call(env, 'POST', `/api/c/${co}/purchases/${flagged}/confirm`, { cookie: a.cookie, body: {} })).status, 409);
  await call(env, 'PUT', `/api/c/${co}/purchases/${flagged}`, { cookie: a.cookie, body: purchaseBody(a, { vendor_doc_no: 'F-1', flags: {} }) });
  assert.equal((await call(env, 'POST', `/api/c/${co}/purchases/${flagged}/confirm`, { cookie: a.cookie, body: {} })).status, 200);
});

test('運費與贈品是獨立行類型；金額留空（依價目表）可入帳，合計不計', async () => {
  const { env, a, co } = await setup();
  const id = (await call(env, 'POST', `/api/c/${co}/purchases`, {
    cookie: a.cookie,
    body: purchaseBody(a, { items: [
      { raw_name: '辣鳳', product_id: a.product, cases: 36, packs: 1080 },
      { line_type: 'gift', raw_name: '贈-小運費', amount: 0 },
      { line_type: 'freight', raw_name: '運費', amount: 200 },
    ] }),
  })).data.id;
  const doc = (await call(env, 'GET', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie })).data;
  assert.deepEqual(doc.items.map((i) => i.line_type), ['product', 'gift', 'freight']);
  assert.equal(doc.items[0].amount, null);
  assert.equal(doc.total_amount, 200);
  assert.equal((await call(env, 'POST', `/api/c/${co}/purchases/${id}/confirm`, { cookie: a.cookie, body: {} })).status, 200);
});

test('訂單：建立、確認、依客戶與單號搜尋；銷貨單號重複要提醒', async () => {
  const { env, a, co } = await setup();
  const body = { customer_id: a.customer, sales_no: 'X-100', doc_date: '2026-11-11', salesperson: '小王', tax_amount: 5,
    items: [{ raw_name: '辣鳳', product_id: a.product, qty: 10, unit: '箱', unit_price_x100: 50000, amount: 5000 }] };
  const id = (await call(env, 'POST', `/api/c/${co}/orders`, { cookie: a.cookie, body })).data.id;
  assert.equal((await call(env, 'POST', `/api/c/${co}/orders/${id}/confirm`, { cookie: a.cookie, body: {} })).status, 200);
  assert.equal((await call(env, 'GET', `/api/c/${co}/orders?q=X-100`, { cookie: a.cookie })).data.total, 1);
  assert.equal((await call(env, 'GET', `/api/c/${co}/orders?customer_id=${a.customer}`, { cookie: a.cookie })).data.total, 1);
  const again = (await call(env, 'POST', `/api/c/${co}/orders`, { cookie: a.cookie, body })).data.id;
  assert.equal((await call(env, 'POST', `/api/c/${co}/orders/${again}/confirm`, { cookie: a.cookie, body: {} })).status, 409);
});

test('沒開通「進貨訂單」的店家，單據 API 一律 403', async () => {
  const { env, a, co } = await setup();
  env.DB.raw.prepare("INSERT INTO store_modules (store_id, module_key, enabled, updated_at) VALUES ('alpha','purchaseOrders',0,'x')").run();
  assert.equal((await call(env, 'GET', `/api/c/${co}/purchases`, { cookie: a.cookie })).status, 403);
  assert.equal((await call(env, 'POST', `/api/c/${co}/files`, { cookie: a.cookie, form: new FormData() })).status, 403);
});

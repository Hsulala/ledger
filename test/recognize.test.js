import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, getDb, purchaseBody, seedStore } from './helpers/app.js';
import { matchParty, parseDateText, toInt } from '../src/ai/normalize.js';

const jpeg = (seed) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, seed, seed + 1, seed + 2]);
const form = (...seeds) => { const f = new FormData(); for (const s of seeds) f.append('files', new File([jpeg(s)], `p${s}.jpg`, { type: 'image/jpeg' })); return f; };

const PURCHASE_OUTPUT = {
  doc_kind: 'purchase_delivery', doc_title: '出貨單', vendor_name: '欣洲食品有限公司', vendor_tax_id: null,
  buyer_name: '翔慧有限公司', buyer_tax_id: '60587043', doc_no: '1151001A01000001', date_text: '115/10/01', tax_mode: 'excl',
  printed_tax: null, printed_total: 99999,
  items: [
    { name: '鳳爪', packs: 1080, unit: '包', unit_price: 114, amount: 34200 },
    { name: '運費', line_type: 'freight', amount: 300 },
    { name: '看不清的品項', amount: null, uncertain_fields: ['amount'] },
  ],
  handwritten_notes: ['33250+1663=34913'],
};

function fakeModel(output) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ content: [{ type: 'tool_use', name: 'record_document', input: output }], usage: { input_tokens: 1500, output_tokens: 300 } });
  };
  impl.calls = calls;
  return impl;
}

async function setup(output = PURCHASE_OUTPUT) {
  const fetchImpl = fakeModel(output);
  const env = createEnv({ ANTHROPIC_API_KEY: 'test-key', FETCH_IMPL: fetchImpl });
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const db = getDb(env);
  await db.system.setModules('alpha', { documentRecognition: true });
  await a.scope.update('vendors', a.vendor, { name: '欣洲' });
  const co = a.companyIds['翔慧'];
  const upload = async (...seeds) => (await call(env, 'POST', `/api/c/${co}/files`, { cookie: a.cookie, form: form(...seeds) })).data.files.map((f) => f.id);
  return { env, a, co, fetchImpl, upload, db };
}

test('日期換算：民國、西元、兩位數年；讀不懂的不猜', () => {
  const today = new Date('2026-11-19T00:00:00Z');
  assert.deepEqual(parseDateText('115/10/01', today), { date: '2026-10-01', uncertain: false });
  assert.equal(parseDateText('0115/09/26', today).date, '2026-09-26');
  assert.equal(parseDateText('115.10.28', today).date, '2026-10-28');
  assert.deepEqual(parseDateText('26.10.01', today), { date: '2026-10-01', uncertain: false });
  assert.equal(parseDateText('2026/11/13', today).date, '2026-11-13');
  assert.equal(parseDateText('115/13/40', today).date, null);
  assert.equal(parseDateText('', today).date, null);
  assert.equal(parseDateText('99.10.01', today).uncertain, true);
});

test('金額取整：非整數標為不確定；廠商以統編優先、名稱次之、有歧義不猜', () => {
  assert.deepEqual(toInt('1,630'), { value: 1630, uncertain: false });
  assert.equal(toInt(12.5).uncertain, true);
  const rows = [{ id: 1, name: '欣洲', tax_id: '12345678', aliases: '[]' }, { id: 2, name: '宏海', tax_id: null, aliases: '["宏海實業"]' }];
  assert.equal(matchParty(rows, { name: '不相干', taxId: '12345678' }).id, 1);
  assert.equal(matchParty(rows, { name: '欣洲食品有限公司' }).id, 1);
  assert.equal(matchParty(rows, { name: '宏海實業股份有限公司' }).id, 2);
  assert.equal(matchParty([...rows, { id: 3, name: '欣洲冷凍', tax_id: null, aliases: '[]' }], { name: '欣洲' }).id, 1);
  assert.equal(matchParty([{ id: 1, name: '欣洲甲', aliases: '[]' }, { id: 2, name: '欣洲乙', aliases: '[]' }], { name: '欣洲食品' }), null);
});

test('判讀：建立草稿、金額由程式加總、標黃與提醒、手寫字不帶入、用量記錄', async () => {
  const { env, a, co, fetchImpl, upload } = await setup();
  const [fid] = await upload(1);
  const res = await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [fid] } });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'draft');
  assert.equal(res.data.kind, 'purchase');
  assert.deepEqual(res.data.usage, { used: 1, limit: 300 });

  const doc = (await call(env, 'GET', `/api/c/${co}/purchases/${res.data.id}`, { cookie: a.cookie })).data;
  assert.equal(doc.status, 'draft');
  assert.equal(doc.source, 'photo');
  assert.equal(doc.vendor_id, a.vendor);
  assert.equal(doc.doc_type, 'shipment');
  assert.equal(doc.doc_date, '2026-10-01');
  assert.equal(doc.doc_date_raw, '115/10/01');
  assert.equal(doc.total_amount, 34500); // 程式加總，不採用 AI 讀到的 99999
  assert.match(doc.note, /單上合計 99999 與品項加總 34500 不一致/);
  assert.match(doc.note, /手寫字/);
  assert.ok(!doc.note.includes('33250'));
  const items = doc.items;
  assert.equal(items[0].packs, 1080);
  assert.equal(items[0].unit_price_x100, 11400);
  assert.equal(JSON.parse(items[0].flags).product_id, true); // 沒對上商品 → 標黃
  assert.equal(JSON.parse(items[2].flags).amount, true);
  assert.equal(doc.files.length, 1);

  const call0 = fetchImpl.calls[0];
  assert.equal(call0.headers['x-api-key'], 'test-key');
  assert.equal(call0.body.tool_choice.name, 'record_document');
  assert.equal(call0.body.messages[0].content[0].type, 'image');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE purpose = 'recognize'").get().n, 1);
  assert.equal(env.DB.raw.prepare("SELECT status FROM extractions").get().status, 'built');
  // 同一批檔案不能重複判讀
  assert.equal((await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [fid] } })).status, 409);
});

test('品名對照：確認過的寫法下次自動對應', async () => {
  const { env, a, co, upload } = await setup();
  await a.scope.create('vendor_item_aliases', { vendor_id: a.vendor, raw_name: '鳳爪', product_id: a.product, created_at: new Date().toISOString() });
  const [fid] = await upload(2);
  const res = await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [fid] } });
  const doc = (await call(env, 'GET', `/api/c/${co}/purchases/${res.data.id}`, { cookie: a.cookie })).data;
  assert.equal(doc.items[0].product_id, a.product);
  assert.equal(JSON.parse(doc.items[0].flags).product_id, undefined);
});

test('找不到廠商：不建草稿也不亂猜；補建廠商後可重新比對，不再呼叫 AI、不再計次', async () => {
  const output = { ...PURCHASE_OUTPUT, vendor_name: '全新廠商有限公司' };
  const { env, a, co, fetchImpl, upload } = await setup(output);
  const [fid] = await upload(3);
  const res = await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [fid] } });
  assert.equal(res.data.status, 'need_vendor');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 0);
  await a.scope.create('vendors', { name: '全新廠商', category: 'chicken_feet', created_at: new Date().toISOString() });
  const again = await call(env, 'POST', `/api/c/${co}/extractions/${res.data.extraction_id}/build`, { cookie: a.cookie, body: {} });
  assert.equal(again.data.status, 'draft');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM ai_usage").get().n, 1);
  assert.equal((await call(env, 'POST', `/api/c/${co}/extractions/${res.data.extraction_id}/build`, { cookie: a.cookie, body: {} })).status, 409);
});

test('對帳單與請款單：目前只保留判讀結果，不建單據', async () => {
  const { env, a, co, upload } = await setup({ doc_kind: 'vendor_statement', items: [] });
  const [fid] = await upload(4);
  const res = await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [fid] } });
  assert.equal(res.data.status, 'unsupported');
  assert.match(res.data.message, /對帳單/);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 0);
});

test('每月上限：到了就拒絕；後台可調整；模組沒開不能用；沒有金鑰會說明', async () => {
  const { env, a, co, upload, db } = await setup();
  const admin = (await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } })).cookie;
  assert.equal((await call(env, 'PUT', '/api/admin/stores/alpha/ai', { cookie: admin, body: { limit: 1 } })).data.limit, 1);
  assert.equal((await call(env, 'PUT', '/api/admin/stores/alpha/ai', { cookie: admin, body: { limit: -5 } })).status, 400);
  const [f1, f2] = await upload(5, 6);
  assert.equal((await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [f1] } })).status, 200);
  const over = await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [f2] } });
  assert.equal(over.status, 429);
  assert.match(over.data.error ?? over.data.message ?? '', /上限/);
  await call(env, 'PUT', '/api/admin/stores/alpha/ai', { cookie: admin, body: { limit: 5 } });
  await db.system.setModules('alpha', { documentRecognition: false });
  assert.equal((await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [f2] } })).status, 403);
  await db.system.setModules('alpha', { documentRecognition: true });
  delete env.ANTHROPIC_API_KEY;
  assert.equal((await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [f2] } })).status, 503);
});

test('隔離：別家店不能判讀或重建這家店的檔案與判讀結果', async () => {
  const { env, a, co, upload } = await setup();
  const b = await seedStore(env, { id: 'beta', name: '乙店' });
  await getDb(env).system.setModules('beta', { documentRecognition: true });
  const [fid] = await upload(7);
  const bco = b.companyIds['翔慧'];
  assert.equal((await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: b.cookie, body: { file_ids: [fid] } })).status, 404);
  assert.equal((await call(env, 'POST', `/api/c/${bco}/recognize`, { cookie: b.cookie, body: { file_ids: [fid] } })).status, 404);
  const res = await call(env, 'POST', `/api/c/${co}/recognize`, { cookie: a.cookie, body: { file_ids: [fid] } });
  assert.equal((await call(env, 'POST', `/api/c/${bco}/extractions/${res.data.extraction_id}/build`, { cookie: b.cookie, body: {} })).status, 404);
});

test('確認入帳後記下人工確認的品名對照；訂單與沒對應商品的行不記', async () => {
  const { env, a, co } = await setup();
  const made = await call(env, 'POST', `/api/c/${co}/purchases`, { cookie: a.cookie, body: purchaseBody(a) });
  assert.equal((await call(env, 'POST', `/api/c/${co}/purchases/${made.data.id}/confirm`, { cookie: a.cookie, body: {} })).status, 200);
  const rows = env.DB.raw.prepare('SELECT raw_name, product_id, vendor_id FROM vendor_item_aliases').all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { raw_name: '辣鳳', product_id: a.product, vendor_id: a.vendor });
});

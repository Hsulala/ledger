import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, seedStore } from './helpers/app.js';
import { normalizeCustomers, normalizeProducts, normalizeVendors, detectKind, rowsToObjects } from '../src/import/master.js';

const v = (code, name, extra = {}) => ({ 廠商代號: code, 廠商簡稱: name, ...extra });

test('廠商整理：用「/」分隔的名稱拆成別名、依代號首字分類、統編只收 8 位數字（Excel 的浮點寫法也能轉）', () => {
  const { rows, issues } = normalizeVendors([
    v('A07', '宏海/億元寢飾', { 統一編號: null }),
    v('A04', '東洋寢飾行', { 統一編號: 77397232.0 }),
    v('B01', '欣洲食品', { 統一編號: '12345' }),
    v('C01', '泓珊(運費)'),
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.legacy_code, r]));
  assert.deepEqual(JSON.parse(by.A07.aliases), ['宏海', '億元寢飾']);
  assert.equal(by.A04.tax_id, '77397232');
  assert.equal(by.A04.group_name, '寢具'); assert.equal(by.A04.category, 'bedding');
  assert.equal(by.B01.group_name, '食品'); assert.equal(by.B01.tax_id, null);
  assert.equal(by.C01.group_name, '其他');
  assert.ok(issues.some((i) => i.kind === 'bad_tax_id' && i.key === 'B01'));
  assert.ok(issues.some((i) => i.kind === 'no_tax_id' && i.key === 'A07' && i.severity === 'info'));
});

test('商品整理：庫存與標準進價不匯入、分類對應、零售價換成 x100、同名不同品號要列出、不自動合併', () => {
  const { rows, issues } = normalizeProducts([
    { 品號: '60SAB-5-HH', 品名: '60支天絲AB-5尺(HH)', 單位: '組', 商品分類: '60支天絲', 零售價: 2800, 標準進價: 2800, 庫存量: -5 },
    { 品號: 'Z600-1', 品名: '原味鳳爪 600g裝', 單位: '包', 商品分類: '麻辣事業', 零售價: 170, 標準進價: 0, 庫存量: 100 },
    { 品號: 'HC1', 品名: '冷凍包', 單位: '箱', 商品分類: '冷凍即食包', 零售價: 0 },
    { 品號: 'TR20', 品名: '大紅袍花椒粒', 單位: '斤', 商品分類: '麻辣事業', 零售價: 500 },
    { 品號: 'TR243', 品名: '大紅袍花椒粒', 單位: '斤', 商品分類: '麻辣事業', 零售價: 0 },
    { 品號: '', 品名: '沒品號' },
  ]);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => !('stock' in r) && !('庫存量' in r) && !('標準進價' in r)));
  const by = Object.fromEntries(rows.map((r) => [r.sku, r]));
  assert.equal(by['60SAB-5-HH'].category, 'bedding'); assert.equal(by['60SAB-5-HH'].list_price_x100, 280000);
  assert.equal(by['Z600-1'].category, null); assert.equal(by['Z600-1'].group_name, '麻辣事業');
  assert.equal(by.HC1.category, 'ready_meal'); assert.equal(by.HC1.list_price_x100, null);
  const dup = issues.find((i) => i.kind === 'dup_product_name');
  assert.equal(dup.name, '大紅袍花椒粒'); assert.match(dup.key, /TR20/); assert.match(dup.key, /TR243/);
  assert.ok(issues.some((i) => i.kind === 'product_missing'));
  assert.ok(issues.some((i) => i.kind === 'no_list_price' && i.key === 'HC1'));
});

test('客戶整理：請款客戶不同於自己時記下來、潛在客戶先停用、同名不同代號列出', () => {
  const { rows, issues } = normalizeCustomers([
    { 客戶代號: 'D02', 客戶簡稱: '瑞哥雞肉飯', 請款客戶: '瑞哥雞肉飯', 客戶類型: '正式客戶', 統一編號: 80588690, 電話: '02-1', 手機: '0987' },
    { 客戶代號: 'ML1', 客戶簡稱: '瑞哥信義店', 請款客戶: '瑞哥雞肉飯', 客戶類型: '正式客戶' },
    { 客戶代號: 'ML2', 客戶簡稱: '潛客', 請款客戶: '潛客', 客戶類型: '潛在客戶' },
    { 客戶代號: 'L1304', 客戶簡稱: '劉俊賢', 請款客戶: '劉俊賢' },
    { 客戶代號: 'ML1125', 客戶簡稱: '劉俊賢', 請款客戶: '劉俊賢' },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(by.D02.bill_to_name, null); assert.equal(by.D02.tax_id, '80588690');
  assert.equal(by.ML1.bill_to_name, '瑞哥雞肉飯');
  assert.equal(by.ML2.active, 0); assert.equal(by.D02.active, 1);
  assert.ok(issues.some((i) => i.kind === 'dup_customer_name' && i.name === '劉俊賢'));
  assert.equal(rows.length, 5);
});

test('偵測檔案種類與轉成物件', () => {
  assert.equal(detectKind(['序', '品號', '品名']), 'products');
  assert.equal(detectKind(['序', '客戶代號', '客戶簡稱']), 'customers');
  assert.equal(detectKind(['序', '廠商代號', '廠商簡稱']), 'vendors');
  assert.equal(detectKind(['a', 'b']), null);
  assert.deepEqual(rowsToObjects([['品號', '品名'], ['A', '甲'], [null, null]]), [{ 品號: 'A', 品名: '甲' }]);
});

async function adminCookie(env) {
  return (await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } })).cookie;
}
const customerRows = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ 客戶代號: `ML${offset + i}`, 客戶簡稱: `客戶${offset + i}`, 請款客戶: `客戶${offset + i}`, 客戶類型: '正式客戶' }));

test('匯入 API：預覽不寫入；確認才寫入；重複匯入只略過不覆蓋；只有管理者能用；別家店不受影響', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const b = await seedStore(env, { id: 'beta', name: '乙店' });
  const admin = await adminCookie(env);
  const url = '/api/admin/stores/alpha/import/customers';

  assert.equal((await call(env, 'POST', url, { body: { rows: [] } })).status, 401);
  assert.equal((await call(env, 'POST', url, { cookie: a.cookie, body: { rows: [] } })).status, 401);

  const rows = customerRows(3);
  const pre = await call(env, 'POST', url, { cookie: admin, body: { rows } });
  assert.equal(pre.status, 200);
  assert.deepEqual({ total: pre.data.total, new: pre.data.new, existing: pre.data.existing, committed: pre.data.committed }, { total: 3, new: 3, existing: 0, committed: undefined });
  assert.equal(await a.scope.count('customers'), 1); // 只有 seed 的那一筆

  const done = await call(env, 'POST', url, { cookie: admin, body: { rows, commit: true } });
  assert.equal(done.data.committed, true);
  assert.equal(await a.scope.count('customers'), 4);
  assert.equal(await b.scope.count('customers'), 1);

  // 在系統裡改過名稱後，再匯入同一份不會蓋掉
  const mine = (await a.scope.list('customers', { where: { code: 'ML0' } }))[0];
  await a.scope.update('customers', mine.id, { name: '我改過的名稱' });
  const again = await call(env, 'POST', url, { cookie: admin, body: { rows: [...rows, ...customerRows(1, 10)], commit: true } });
  assert.deepEqual({ new: again.data.new, existing: again.data.existing }, { new: 1, existing: 3 });
  assert.equal((await a.scope.get('customers', mine.id)).name, '我改過的名稱');

  assert.equal((await call(env, 'POST', '/api/admin/stores/alpha/import/nothing', { cookie: admin, body: { rows: [] } })).status, 404);
  assert.equal((await call(env, 'POST', '/api/admin/stores/ghost/import/customers', { cookie: admin, body: { rows: [] } })).status, 404);
  assert.equal((await call(env, 'POST', url, { cookie: admin, body: { rows: 'x' } })).status, 400);
});

test('匯入後商品、客戶超過 500 筆，設定頁的完整清單 API 仍然讀得完', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const admin = await adminCookie(env);
  const done = await call(env, 'POST', '/api/admin/stores/alpha/import/customers', { cookie: admin, body: { rows: customerRows(1200), commit: true } });
  assert.equal(done.data.new, 1200);
  const list = await call(env, 'GET', '/api/master/customers', { cookie: a.cookie });
  assert.equal(list.data.rows.length, 1201);
  const prods = await call(env, 'POST', '/api/admin/stores/alpha/import/products', { cookie: admin, body: { rows: [{ 品號: 'X1', 品名: '甲', 單位: '組', 商品分類: '60支天絲', 零售價: 100 }], commit: true } });
  assert.equal(prods.data.new, 1);
  const vend = await call(env, 'POST', '/api/admin/stores/alpha/import/vendors', { cookie: admin, body: { rows: [{ 廠商代號: 'A01', 廠商簡稱: '軒維' }, { 廠商代號: 'B01', 廠商簡稱: '欣洲食品' }], commit: true } });
  assert.equal(vend.data.new, 2);
  const vs = (await call(env, 'GET', '/api/master/vendors', { cookie: a.cookie })).data.rows;
  assert.equal(vs.find((x) => x.name === '欣洲食品').group_name, '食品');
});

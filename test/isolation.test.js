import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, createEnv, purchaseBody, seedStore } from './helpers/app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('只有 src/db 能直接使用資料庫（強制條件層是唯一入口）', () => {
  const offenders = [];
  for (const file of walk(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
    if (file.includes(`${join('src', 'db')}`)) continue;
    const text = readFileSync(file, 'utf8');
    if (/\.prepare\(|env\.DB\b|\.batch\(/.test(text)) offenders.push(file.replace(root, ''));
  }
  assert.deepEqual(offenders, []);
});

test('跨店隔離：甲店使用者讀不到、改不到乙店的任何資料', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const b = await seedStore(env, { id: 'beta', name: '乙店' });
  const aco = a.companyIds['翔慧'], bco = b.companyIds['翔慧'];

  const made = await call(env, 'POST', `/api/c/${bco}/purchases`, { cookie: b.cookie, body: purchaseBody(b) });
  assert.equal(made.status, 201);
  const bid = made.data.id;

  // 甲店用乙店的公司代號 → 找不到
  assert.equal((await call(env, 'GET', `/api/c/${bco}/purchases`, { cookie: a.cookie })).status, 404);
  assert.equal((await call(env, 'POST', `/api/c/${bco}/purchases`, { cookie: a.cookie, body: purchaseBody(a) })).status, 404);
  // 甲店用自己的公司代號去讀乙店的單據 → 找不到
  assert.equal((await call(env, 'GET', `/api/c/${aco}/purchases/${bid}`, { cookie: a.cookie })).status, 404);
  assert.equal((await call(env, 'PUT', `/api/c/${aco}/purchases/${bid}`, { cookie: a.cookie, body: purchaseBody(a) })).status, 404);
  assert.equal((await call(env, 'POST', `/api/c/${aco}/purchases/${bid}/confirm`, { cookie: a.cookie, body: {} })).status, 404);
  // 甲店不能引用乙店的廠商、商品
  const cross = await call(env, 'POST', `/api/c/${aco}/purchases`, { cookie: a.cookie, body: purchaseBody(b) });
  assert.equal(cross.status, 400);
  // 主檔列表只看到自己店的資料
  for (const kind of ['vendors', 'products', 'customers', 'companies']) {
    const rows = (await call(env, 'GET', `/api/master/${kind}`, { cookie: a.cookie })).data.rows;
    assert.ok(rows.length > 0 && rows.every((r) => r.store_id === 'alpha'), kind);
  }
  // 乙店的單據完全沒被動到
  const still = await call(env, 'GET', `/api/c/${bco}/purchases/${bid}`, { cookie: b.cookie });
  assert.equal(still.data.status, 'draft');
  assert.equal(still.data.items.length, 2);
});

test('兩家買方公司分開：甲公司的單據不會出現在乙公司的清單', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const c1 = a.companyIds['翔慧'], c2 = a.companyIds['翔媁'];
  const one = await call(env, 'POST', `/api/c/${c1}/purchases`, { cookie: a.cookie, body: purchaseBody(a) });
  await call(env, 'POST', `/api/c/${c2}/purchases`, { cookie: a.cookie, body: purchaseBody(a, { vendor_doc_no: 'S-777' }) });

  const list1 = (await call(env, 'GET', `/api/c/${c1}/purchases`, { cookie: a.cookie })).data;
  const list2 = (await call(env, 'GET', `/api/c/${c2}/purchases`, { cookie: a.cookie })).data;
  assert.deepEqual(list1.rows.map((r) => r.vendor_doc_no), ['S-001']);
  assert.deepEqual(list2.rows.map((r) => r.vendor_doc_no), ['S-777']);
  // 用公司 2 的路徑去讀公司 1 的單據 → 找不到
  assert.equal((await call(env, 'GET', `/api/c/${c2}/purchases/${one.data.id}`, { cookie: a.cookie })).status, 404);
  assert.equal((await call(env, 'GET', `/api/c/${c2}/pending`, { cookie: a.cookie })).data.purchases.length, 1);
});

test('未登入、已停用的店家與使用者都進不來', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  assert.equal((await call(env, 'GET', '/api/me')).status, 401);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: a.cookie })).status, 200);
  env.DB.raw.prepare("UPDATE stores SET status = 'paused' WHERE id = 'alpha'").run();
  assert.equal((await call(env, 'GET', '/api/me', { cookie: a.cookie })).status, 401);
  env.DB.raw.prepare("UPDATE stores SET status = 'active' WHERE id = 'alpha'").run();
  env.DB.raw.prepare("UPDATE store_users SET status = 'disabled'").run();
  assert.equal((await call(env, 'GET', '/api/me', { cookie: a.cookie })).status, 401);
});

test('staff 不能新增主檔或改主題色', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店', role: 'staff' });
  assert.equal((await call(env, 'POST', '/api/master/vendors', { cookie: a.cookie, body: { name: 'X', category: 'bedding' } })).status, 403);
  assert.equal((await call(env, 'PATCH', '/api/store/theme', { cookie: a.cookie, body: { theme_color: '#112233' } })).status, 403);
});

import { createD1, createR2, migrate } from './d1.js';
import { handle } from '../../src/worker.js';
import worker from '../../src/worker.js';
import { getDb } from '../../src/db/index.js';

export function createEnv(extra = {}) {
  const d1 = createD1();
  migrate(d1);
  return {
    DB: d1, FILES: createR2(), SESSION_SECRET: 'x'.repeat(40), DEV_LOGIN: '1',
    ADMIN_PASSWORD: 'admin-password-1', LINE_LOGIN_CHANNEL_ID: 'chan', LINE_LOGIN_CHANNEL_SECRET: 'secret',
    ...extra,
  };
}

// 送一個請求進 Worker。cookies 是 'name=value; ...' 字串
export async function call(env, method, path, { body, cookie, headers = {}, form, host = 'localhost' } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (form) init.body = form;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const response = await worker.fetch(new Request(`http://${host}${path}`, init), env);
  const type = response.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await response.json() : null;
  const setCookie = response.headers.getSetCookie?.() ?? [];
  return { status: response.status, data, response, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') };
}

// 建立一家店、一位已綁定的負責人、兩家買方公司；回傳登入用 cookie
export async function seedStore(env, { id, name, userName = '負責人', role = 'owner', companies = ['翔慧', '翔媁'] }) {
  const db = getDb(env);
  await db.system.createStore({ id, name });
  const tokenHash = `h-${id}-${role}`;
  const userId = await db.system.createUserWithInvite({ storeId: id, displayName: userName, role, tokenHash, expiresAt: '2999-01-01T00:00:00Z' });
  env.DB.raw.prepare('UPDATE store_users SET line_user_id = ? WHERE id = ?').run(`U-${id}-${role}`, userId);
  const login = await call(env, 'POST', '/api/dev/login', { body: { user_id: userId } });
  const s = db.scope(id);
  const companyIds = {};
  for (const n of companies) companyIds[n] = await s.create('companies', { name: n, created_at: new Date().toISOString() });
  const vendor = await s.create('vendors', { name: `${id}-廠商`, category: 'chicken_feet', created_at: new Date().toISOString() });
  const product = await s.create('products', { name: `${id}-辣鳳爪`, sku: 'A1', unit: '箱', pack_per_case: 30, created_at: new Date().toISOString() });
  const customer = await s.create('customers', { name: `${id}-客戶`, code: 'C1', created_at: new Date().toISOString() });
  return { id, userId, cookie: login.cookie, companyIds, vendor, product, customer, scope: s };
}

export const purchaseBody = (store, extra = {}) => ({
  vendor_id: store.vendor, doc_type: 'shipment', vendor_doc_no: 'S-001', doc_date: '2026-11-10', doc_date_raw: '115/11/10',
  items: [
    { line_type: 'product', raw_name: '辣鳳', product_id: store.product, cases: 36, packs: 1080, unit: '箱', unit_price_x100: 11400, amount: 34200 },
    { line_type: 'freight', raw_name: '運費', amount: 300 },
  ],
  ...extra,
});

export { handle, getDb };

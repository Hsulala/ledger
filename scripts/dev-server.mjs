// 本機預覽（不需要 Cloudflare 帳號）：用記憶體資料庫模擬 D1 與 R2，載入範例資料。重新啟動就清空。
//   node --no-warnings scripts/dev-server.mjs        然後開 http://localhost:8787/__dev/login（自動以範例店家登入）
//   後台：http://localhost:8787/admin.html（帳號 admin、密碼 admin-password-1）
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { getDb } from '../src/db/index.js';
import { createD1, createR2, migrate } from '../test/helpers/d1.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT) || 8787;

const d1 = createD1();
migrate(d1);
const env = {
  DB: d1, FILES: createR2(), SESSION_SECRET: 'dev-secret-dev-secret-dev-secret-dev!', DEV_LOGIN: '1',
  ADMIN_PASSWORD: 'admin-password-1', LINE_LOGIN_CHANNEL_ID: 'dev', LINE_LOGIN_CHANNEL_SECRET: 'dev',
  ASSETS: {
    async fetch(request) {
      let path = new URL(request.url).pathname;
      if (path === '/') path = '/index.html';
      if (!extname(path)) path += '.html';
      try { return new Response(await readFile(join(root, 'public', path)), { headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' } }); } catch { return new Response('Not Found', { status: 404 }); }
    },
  },
};

// 範例資料
const db = getDb(env);
const t = new Date().toISOString();
await db.system.createStore({ id: 'mamie', name: 'Mamie 的店' });
const userId = await db.system.createUserWithInvite({ storeId: 'mamie', displayName: 'Mamie', role: 'owner', tokenHash: 'dev', expiresAt: '2999-01-01T00:00:00Z' });
d1.raw.prepare('UPDATE store_users SET line_user_id = ? WHERE id = ?').run('U-dev', userId);
const s = db.scope('mamie');
const c1 = await s.create('companies', { name: '翔慧', created_at: t });
await s.create('companies', { name: '翔瑋', created_at: t });
const v1 = await s.create('vendors', { name: '欣洲', category: 'chicken_feet', created_at: t });
await s.create('vendors', { name: '宏海', category: 'bedding', created_at: t });
const p1 = await s.create('products', { sku: 'CF-01', name: '辣鳳爪', unit: '箱', pack_per_case: 30, category: 'chicken_feet', created_at: t });
await s.create('products', { sku: 'CF-02', name: '原味鳳爪', unit: '箱', pack_per_case: 30, category: 'chicken_feet', created_at: t });
await s.create('customers', { code: 'A001', name: '瑞哥古亭店', created_at: t });
void c1; void v1; void p1;

// 本機預覽用的假 AI：不連外網，回傳一份固定的範例判讀結果（正式站不會有這段）
await db.system.setModules('mamie', { documentRecognition: true });
env.ANTHROPIC_API_KEY = 'dev';
env.FETCH_IMPL = async () => Response.json({
  content: [{ type: 'tool_use', name: 'record_document', input: {
    doc_kind: 'purchase_delivery', doc_title: '出貨單', vendor_name: '欣洲食品有限公司', buyer_name: '翔慧有限公司', doc_no: '1151001A01000002',
    date_text: '115/10/01', tax_mode: 'excl', printed_total: 99000,
    items: [
      { name: '辣鳳爪', cases: 36, packs: 1080, unit: '箱', unit_price: 114, amount: 34200 },
      { name: '原味鴨舌', packs: 12500, unit: '支', amount: 6250, uncertain_fields: ['unit_price'] },
      { name: '運費', line_type: 'freight', amount: 300 },
    ],
    uncertain_fields: ['doc_no'], handwritten_notes: ['33250+1663'],
  } }],
  usage: { input_tokens: 1800, output_tokens: 350 },
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/__dev/login') {
      const r = await worker.fetch(new Request(`http://localhost:${port}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: userId }) }), env);
      res.writeHead(302, { location: '/', 'set-cookie': r.headers.getSetCookie() });
      return res.end();
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, duplex: 'half' }), env);
    const headers = {};
    for (const [k, v] of response.headers) if (k !== 'set-cookie') headers[k] = v;
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
}).listen(port, () => console.log(`帳房本機預覽：http://localhost:${port}/__dev/login`));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, purchaseBody, seedStore } from './helpers/app.js';
import { checkLink, signLink } from '../src/files.js';

const jpeg = (seed = 1) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, seed, seed + 1, seed + 2]);
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

function formOf(...files) {
  const form = new FormData();
  for (const [name, bytes, type] of files) form.append('files', new File([bytes], name, { type: type ?? 'image/jpeg' }));
  return form;
}

async function setup() {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const b = await seedStore(env, { id: 'beta', name: '乙店' });
  return { env, a, b, co: a.companyIds['翔慧'] };
}

test('多張上傳：存進店家專屬路徑，相同照片只存一份（去重）', async () => {
  const { env, a, co } = await setup();
  const up = await call(env, 'POST', `/api/c/${co}/files`, { cookie: a.cookie, form: formOf(['a.jpg', jpeg(1)], ['b.png', png(), 'image/png'], ['a-again.jpg', jpeg(1)]) });
  assert.equal(up.status, 201);
  const [f1, f2, f3] = up.data.files;
  assert.equal(f1.duplicate, false);
  assert.equal(f2.duplicate, false);
  assert.equal(f3.duplicate, true);
  assert.equal(f3.id, f1.id);
  assert.equal(env.FILES.map.size, 2);
  for (const key of env.FILES.map.keys()) assert.ok(key.startsWith('stores/alpha/files/'), key);
  // 再傳一次同一張 → 仍是重複
  const again = await call(env, 'POST', `/api/c/${co}/files`, { cookie: a.cookie, form: formOf(['x.jpg', jpeg(1)]) });
  assert.equal(again.data.files[0].duplicate, true);
  assert.equal((await call(env, 'GET', `/api/c/${co}/pending`, { cookie: a.cookie })).data.files.length, 2);
});

test('以檔頭判定真實格式：偽裝成圖片的 HTML、SVG、純文字都被拒絕', async () => {
  const { env, a, co } = await setup();
  const enc = (s) => new TextEncoder().encode(s);
  const up = await call(env, 'POST', `/api/c/${co}/files`, {
    cookie: a.cookie,
    form: formOf(['evil.jpg', enc('<html><script>alert(1)</script></html>'), 'image/jpeg'], ['x.svg', enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'], ['ok.jpg', jpeg(9)]),
  });
  assert.equal(up.status, 201);
  assert.ok(up.data.files[0].error && up.data.files[1].error);
  assert.ok(up.data.files[2].id);
  assert.equal(env.FILES.map.size, 1);
  assert.equal((await call(env, 'POST', `/api/c/${co}/files`, { cookie: a.cookie, form: new FormData() })).status, 400);
});

test('照片連結：本店登入者才拿得到；他店、未登入、過期、被改簽名都不行', async () => {
  const { env, a, b, co } = await setup();
  const up = await call(env, 'POST', `/api/c/${co}/files`, { cookie: a.cookie, form: formOf(['a.jpg', jpeg(3)]) });
  const fid = up.data.files[0].id;

  // 他店使用者連連結都拿不到
  assert.equal((await call(env, 'GET', `/api/files/${fid}/link`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(env, 'GET', `/api/files/${fid}/link`)).status, 401);

  const link = await call(env, 'GET', `/api/files/${fid}/link`, { cookie: a.cookie });
  assert.equal(link.status, 200);
  const url = link.data.url;
  const ok = await call(env, 'GET', url, { cookie: a.cookie });
  assert.equal(ok.status, 200);
  assert.equal(ok.response.headers.get('content-type'), 'image/jpeg');
  assert.equal(ok.response.headers.get('cache-control'), 'private, no-store');

  // 連結被轉傳給別人（未登入、或他店登入）→ 不行
  assert.equal((await call(env, 'GET', url)).status, 401);
  assert.equal((await call(env, 'GET', url, { cookie: b.cookie })).status, 403);
  // 簽名被改
  const tampered = url.replace(/sig=(.)/, (_, first) => `sig=${first === '0' ? '1' : '0'}`);
  assert.notEqual(tampered, url);
  assert.equal((await call(env, 'GET', tampered, { cookie: a.cookie })).status, 403);
  // 過期（直接驗簽名函式：6 分鐘後）
  const sig = new URL(`http://x${url}`).searchParams;
  assert.equal(await checkLink(env, 'alpha', fid, sig.get('exp'), sig.get('sig'), Date.now()), true);
  assert.equal(await checkLink(env, 'alpha', fid, sig.get('exp'), sig.get('sig'), Date.now() + 6 * 60_000), false);
  // 他店的店家代號簽不出同一個簽名
  assert.equal(await checkLink(env, 'beta', fid, sig.get('exp'), sig.get('sig')), false);
  void signLink;
});

test('單據附檔：照片掛到單據、確認後變成已歸檔；不能掛別家店或別家公司的檔案', async () => {
  const { env, a, b, co } = await setup();
  const other = a.companyIds['翔瑋'];
  const up = await call(env, 'POST', `/api/c/${co}/files`, { cookie: a.cookie, form: formOf(['p1.jpg', jpeg(5)], ['p2.jpg', jpeg(6)]) });
  const [p1, p2] = up.data.files.map((f) => f.id);
  const id = (await call(env, 'POST', `/api/c/${co}/purchases`, { cookie: a.cookie, body: purchaseBody(a, { file_ids: [p1, p2] }) })).data.id;

  let doc = (await call(env, 'GET', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie })).data;
  assert.deepEqual(doc.files.map((f) => [f.id, f.page_no]), [[p1, 1], [p2, 2]]);
  assert.equal((await call(env, 'GET', `/api/c/${co}/pending`, { cookie: a.cookie })).data.files.length, 0);

  // 別家公司不能引用這份檔案
  assert.equal((await call(env, 'POST', `/api/c/${other}/purchases`, { cookie: a.cookie, body: purchaseBody(a, { file_ids: [p1] }) })).status, 400);
  // 他店不能引用
  const bco = b.companyIds['翔慧'];
  assert.equal((await call(env, 'POST', `/api/c/${bco}/purchases`, { cookie: b.cookie, body: purchaseBody(b, { file_ids: [p1] }) })).status, 400);

  await call(env, 'POST', `/api/c/${co}/purchases/${id}/confirm`, { cookie: a.cookie, body: {} });
  doc = (await call(env, 'GET', `/api/c/${co}/purchases/${id}`, { cookie: a.cookie })).data;
  assert.ok(doc.files.every((f) => f.status === 'attached'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, seedStore } from './helpers/app.js';
import { getDb } from '../src/db/index.js';

// 假的 LINE：授權碼換 id_token、驗證 id_token。lineUser 決定回傳的 sub
function fakeLine(lineUser) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    const body = init?.body;
    if (String(url).endsWith('/token')) return Response.json({ id_token: `idtoken-for-${lineUser.sub}` });
    if (String(url).endsWith('/verify')) {
      if (String(body.get('id_token')) !== `idtoken-for-${lineUser.sub}`) return Response.json({}, { status: 400 });
      return Response.json({ sub: lineUser.sub, name: 'Mamie', nonce: lineUser.nonce });
    }
    return Response.json({}, { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

async function startLogin(env, invite) {
  const res = await call(env, 'GET', `/auth/line/start${invite ? `?invite=${invite}` : ''}`);
  if (res.status !== 302) return { res };
  const location = new URL(res.response.headers.get('location'));
  return { res, state: location.searchParams.get('state'), nonce: location.searchParams.get('nonce'), location };
}

test('後台：第一次用 secret 的帳密建立管理者，之後只認資料庫；密碼錯誤與限流', async () => {
  const env = createEnv();
  assert.equal((await call(env, 'GET', '/api/admin/stores')).status, 401);
  assert.equal((await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'wrong-password' } })).status, 401);
  const ok = await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } });
  assert.equal(ok.status, 200);
  assert.equal((await call(env, 'GET', '/api/admin/stores', { cookie: ok.cookie })).status, 200);
  // 資料庫存的是雜湊，不是明文
  const stored = env.DB.raw.prepare('SELECT password_hash FROM admin_users').get().password_hash;
  assert.ok(stored.startsWith('pbkdf2$') && !stored.includes('admin-password-1'));
  // 店家登入的 Cookie 不能當後台用
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  assert.equal((await call(env, 'GET', '/api/admin/stores', { cookie: a.cookie })).status, 401);
  // 連續失敗 10 次 → 封鎖，連正確密碼也暫時不能登入
  for (let i = 0; i < 10; i += 1) await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: `bad-${i}` } });
  assert.equal((await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } })).status, 429);
});

test('後台建店、設主題色、開關模組（未支援的子功能不能開）、建立使用者並產生綁定連結', async () => {
  const env = createEnv();
  const login = await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } });
  const cookie = login.cookie;
  assert.equal((await call(env, 'POST', '/api/admin/stores', { cookie, body: { id: 'Bad Id', name: 'x' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/admin/stores', { cookie, body: { id: 'mamie', name: 'Mamie 的店', theme_color: '#3e5c76' } })).status, 201);
  assert.equal((await call(env, 'POST', '/api/admin/stores', { cookie, body: { id: 'mamie', name: '重複' } })).status, 409);
  assert.equal((await call(env, 'PATCH', '/api/admin/stores/mamie', { cookie, body: { theme_color: 'red' } })).status, 400);

  const mods = (await call(env, 'GET', '/api/admin/stores/mamie/modules', { cookie })).data.modules;
  assert.equal(mods.purchaseOrders.state, 'on');
  assert.equal(mods.logisticsExport.state, 'unsupported');
  assert.equal((await call(env, 'PUT', '/api/admin/stores/mamie/modules', { cookie, body: { modules: { logisticsExport: true } } })).status, 400);
  const off = await call(env, 'PUT', '/api/admin/stores/mamie/modules', { cookie, body: { modules: { webQuery: false } } });
  assert.equal(off.data.modules.webQuery.state, 'off');

  const invite = await call(env, 'POST', '/api/admin/stores/mamie/users', { cookie, body: { display_name: 'Mamie' } });
  assert.equal(invite.status, 201);
  assert.match(invite.data.link, /\/auth\/line\/start\?invite=[\w-]{40,}/);
  // 資料庫只存權杖雜湊
  const token = new URL(invite.data.link).searchParams.get('invite');
  const rows = env.DB.raw.prepare('SELECT token_hash FROM invites').all();
  assert.ok(rows.every((r) => r.token_hash !== token));
});

test('LINE 登入：用綁定連結綁定、之後直接登入；連結只能用一次；state 只能用一次', async () => {
  const env = createEnv();
  const db = getDb(env);
  const adminLogin = await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } });
  await call(env, 'POST', '/api/admin/stores', { cookie: adminLogin.cookie, body: { id: 'mamie', name: 'Mamie 的店' } });
  const link = (await call(env, 'POST', '/api/admin/stores/mamie/users', { cookie: adminLogin.cookie, body: { display_name: 'Mamie' } })).data.link;
  const invite = new URL(link).searchParams.get('invite');

  // 沒有設定 LINE channel → 503
  const bare = createEnv({ LINE_LOGIN_CHANNEL_ID: undefined });
  assert.equal((await call(bare, 'GET', '/auth/line/start')).status, 503);
  // 假的連結 → 400
  assert.equal((await call(env, 'GET', '/auth/line/start?invite=nope')).status, 400);

  // 綁定
  const login1 = await startLogin(env, invite);
  assert.equal(login1.location.origin, 'https://access.line.me');
  assert.equal(login1.location.searchParams.get('client_id'), 'chan');
  assert.equal(login1.location.searchParams.get('redirect_uri'), 'http://localhost/auth/line/callback');
  env.fetchImpl = fakeLine({ sub: 'U-mamie', nonce: login1.nonce });
  const done = await call(env, 'GET', `/auth/line/callback?code=abc&state=${login1.state}`);
  assert.equal(done.status, 302);
  assert.equal(done.response.headers.get('location'), '/');
  const me = await call(env, 'GET', '/api/me', { cookie: done.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.store.id, 'mamie');
  assert.equal(me.data.user.display_name, 'Mamie');
  assert.ok(done.response.headers.getSetCookie()[0].includes('HttpOnly'));

  // 同一個 state 不能重放
  const replay = await call(env, 'GET', `/auth/line/callback?code=abc&state=${login1.state}`);
  assert.match(replay.response.headers.get('location'), /login_error=state/);
  // 用過的綁定連結失效
  assert.equal((await call(env, 'GET', `/auth/line/start?invite=${invite}`)).status, 400);

  // 之後不用連結，直接 LINE 登入
  const login2 = await startLogin(env);
  env.fetchImpl = fakeLine({ sub: 'U-mamie', nonce: login2.nonce });
  const again = await call(env, 'GET', `/auth/line/callback?code=abc&state=${login2.state}`);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: again.cookie })).status, 200);

  // 沒綁定過的 LINE 帳號 → 不能登入
  const login3 = await startLogin(env);
  env.fetchImpl = fakeLine({ sub: 'U-stranger', nonce: login3.nonce });
  const stranger = await call(env, 'GET', `/auth/line/callback?code=abc&state=${login3.state}`);
  assert.match(stranger.response.headers.get('location'), /login_error=unbound/);
  assert.equal(stranger.cookie, '');

  // nonce 不符（被竄改的 id_token）→ 失敗
  const login4 = await startLogin(env);
  env.fetchImpl = fakeLine({ sub: 'U-mamie', nonce: 'wrong' });
  const forged = await call(env, 'GET', `/auth/line/callback?code=abc&state=${login4.state}`);
  assert.match(forged.response.headers.get('location'), /login_error=line/);
  void db;
});

test('LIFF：帶 ID token 登入，只有已綁定的帳號能進', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  env.fetchImpl = fakeLine({ sub: `U-${a.id}-owner` });
  const ok = await call(env, 'POST', '/api/auth/liff', { body: { id_token: `idtoken-for-U-${a.id}-owner` } });
  assert.equal(ok.status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: ok.cookie })).status, 200);
  assert.equal((await call(env, 'POST', '/api/auth/liff', { body: { id_token: 'garbage' } })).status, 401);
  env.fetchImpl = fakeLine({ sub: 'U-unknown' });
  assert.equal((await call(env, 'POST', '/api/auth/liff', { body: { id_token: 'idtoken-for-U-unknown' } })).status, 403);
});

test('開發用登入只在 DEV_LOGIN=1 且主機是 localhost 時存在；跨站寫入請求被擋', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  assert.equal((await call(env, 'POST', '/api/dev/login', { host: 'ledger.example.com', body: { user_id: a.userId } })).status, 404);
  const prod = createEnv({ DEV_LOGIN: undefined });
  assert.equal((await call(prod, 'POST', '/api/dev/login', { body: { user_id: 'x' } })).status, 404);
  // 跨站來源
  assert.equal((await call(env, 'POST', '/api/auth/logout', { cookie: a.cookie, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(env, 'POST', '/api/auth/logout', { cookie: a.cookie, headers: { origin: 'http://localhost' } })).status, 200);
  // 登出後 Cookie 失效
  assert.equal((await call(env, 'GET', '/api/me', { cookie: a.cookie })).status, 401);
});

test('店家負責人可以改自己店的主題色；格式錯誤被拒絕；/api/me 回傳主題色', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  assert.equal((await call(env, 'PATCH', '/api/store/theme', { cookie: a.cookie, body: { theme_color: 'blue' } })).status, 400);
  assert.equal((await call(env, 'PATCH', '/api/store/theme', { cookie: a.cookie, body: { theme_color: '#2f6f73' } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: a.cookie })).data.store.theme_color, '#2f6f73');
  assert.equal((await call(env, 'PATCH', '/api/store/theme', { cookie: a.cookie, body: { theme_color: null } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: a.cookie })).data.store.theme_color, null);
});

test('後台預覽：只有後台能用；沒有負責人時拒絕；預覽階段只能進該店並留稽核', async () => {
  const env = createEnv();
  const login = await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } });
  const cookie = login.cookie;
  await call(env, 'POST', '/api/admin/stores', { cookie, body: { id: 'mamie', name: 'Mamie 的店' } });
  await call(env, 'POST', '/api/admin/stores', { cookie, body: { id: 'other', name: '別家' } });
  assert.equal((await call(env, 'POST', '/api/admin/stores/mamie/preview', { body: {} })).status, 401);
  assert.equal((await call(env, 'POST', '/api/admin/stores/mamie/preview', { cookie, body: {} })).status, 409);
  await call(env, 'POST', '/api/admin/stores/mamie/users', { cookie, body: { display_name: 'Mamie' } });
  const pv = await call(env, 'POST', '/api/admin/stores/mamie/preview', { cookie, body: {} });
  assert.equal(pv.status, 200);
  const me = await call(env, 'GET', '/api/me', { cookie: pv.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.store.id, 'mamie');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.preview' AND store_id = 'mamie'").get().n, 1);
  assert.equal((await call(env, 'POST', '/api/admin/stores/nope/preview', { cookie, body: {} })).status, 404);
});

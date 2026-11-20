import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, seedStore } from './helpers/app.js';

const adminLogin = async (env) => (await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } })).cookie;

async function setup() {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const b = await seedStore(env, { id: 'beta', name: '乙店' });
  const admin = await adminLogin(env);
  assert.equal((await call(env, 'PATCH', '/api/admin/stores/alpha', { cookie: admin, body: { host: 'alpha.example.com' } })).status, 200);
  assert.equal((await call(env, 'PATCH', '/api/admin/stores/beta', { cookie: admin, body: { host: 'Beta.Example.com' } })).status, 200);
  return { env, a, b, admin };
}

test('專屬網址：登入階段只在自己的網址有效', async () => {
  const { env, a, b } = await setup();
  assert.equal((await call(env, 'GET', '/api/me', { cookie: a.cookie, host: 'alpha.example.com' })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: a.cookie, host: 'beta.example.com' })).status, 401);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: b.cookie, host: 'alpha.example.com' })).status, 401);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: b.cookie, host: 'beta.example.com' })).status, 200);
});

test('專屬網址不提供後台', async () => {
  const { env, admin } = await setup();
  assert.equal((await call(env, 'GET', '/api/admin/stores', { cookie: admin, host: 'alpha.example.com' })).status, 404);
  assert.equal((await call(env, 'POST', '/api/admin/login', { host: 'alpha.example.com', body: { username: 'admin', password: 'admin-password-1' } })).status, 404);
  assert.equal((await call(env, 'GET', '/api/admin/stores', { cookie: admin })).status, 200);
});

test('LINE 登入：只找得到該店的使用者，且通用網址不能登入有專屬網址的店', async () => {
  const { env, a } = await setup();
  const line = { id_token: 'tok' };
  env.fetchImpl = async () => new Response(JSON.stringify({ sub: 'U-alpha-owner' }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal((await call(env, 'POST', '/api/auth/liff', { host: 'alpha.example.com', body: line })).status, 200);
  assert.equal((await call(env, 'POST', '/api/auth/liff', { host: 'beta.example.com', body: line })).status, 403);
  assert.equal((await call(env, 'POST', '/api/auth/liff', { host: 'localhost', body: line })).status, 403);
  assert.ok(a.userId);
});

test('綁定連結使用該店的專屬網址，且只能在該網址使用', async () => {
  const { env, admin } = await setup();
  const made = await call(env, 'POST', '/api/admin/stores/alpha/users', { cookie: admin, body: { display_name: '新人', role: 'staff' } });
  assert.equal(made.status, 201);
  assert.ok(made.data.link.startsWith('https://alpha.example.com/auth/line/start?invite='));
  const path = new URL(made.data.link).pathname + new URL(made.data.link).search;
  assert.equal((await call(env, 'GET', path, { host: 'beta.example.com' })).status, 400);
  assert.equal((await call(env, 'GET', path, { host: 'localhost' })).status, 400);
  assert.equal((await call(env, 'GET', path, { host: 'alpha.example.com' })).status, 302);
});

test('專屬網址格式與唯一性檢查', async () => {
  const { env, admin } = await setup();
  for (const bad of ['https://x.example.com', 'x.example.com/path', 'x', 'a b.example.com', 'x.example.com:8787']) {
    assert.equal((await call(env, 'PATCH', '/api/admin/stores/alpha', { cookie: admin, body: { host: bad } })).status, 400, bad);
  }
  assert.equal((await call(env, 'PATCH', '/api/admin/stores/beta', { cookie: admin, body: { host: 'alpha.example.com' } })).status, 409);
  assert.equal((await call(env, 'PATCH', '/api/admin/stores/alpha', { cookie: admin, body: { host: null } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: (await call(env, 'POST', '/api/dev/login', { body: { user_id: (await env.DB.raw.prepare('SELECT id FROM store_users WHERE store_id = ?').get('alpha')).id } })).cookie })).status, 200);
});

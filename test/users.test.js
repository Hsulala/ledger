import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, seedStore } from './helpers/app.js';

const adminLogin = async (env) => (await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } })).cookie;
const invite = (env, admin, name, role = 'staff') => call(env, 'POST', '/api/admin/stores/alpha/users', { cookie: admin, body: { display_name: name, role } });

test('可以刪除沒綁定、沒紀錄的使用者；已綁定的不能刪', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const admin = await adminLogin(env);
  const spare = await invite(env, admin, '多餘的');
  assert.equal(spare.status, 201);
  assert.equal((await call(env, 'DELETE', `/api/admin/stores/alpha/users/${spare.data.user_id}`, { cookie: admin })).status, 200);
  const list = (await call(env, 'GET', '/api/admin/stores/alpha/users', { cookie: admin })).data.users;
  assert.ok(!list.some((u) => u.id === spare.data.user_id));
  // 唯一負責人已綁定
  assert.equal((await call(env, 'DELETE', `/api/admin/stores/alpha/users/${a.userId}`, { cookie: admin })).status, 409);
  // 不存在
  assert.equal((await call(env, 'DELETE', `/api/admin/stores/alpha/users/${spare.data.user_id}`, { cookie: admin })).status, 404);
});

test('有操作紀錄的使用者不能刪除，但可以停用；停用後登入立刻失效', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const admin = await adminLogin(env);
  const staff = await invite(env, admin, '店員');
  env.DB.raw.prepare('UPDATE store_users SET line_user_id = ? WHERE id = ?').run('U-staff', staff.data.user_id);
  const login = await call(env, 'POST', '/api/dev/login', { body: { user_id: staff.data.user_id } });
  assert.equal((await call(env, 'GET', '/api/me', { cookie: login.cookie })).status, 200);
  assert.equal((await call(env, 'DELETE', `/api/admin/stores/alpha/users/${staff.data.user_id}`, { cookie: admin })).status, 409);
  assert.equal((await call(env, 'PATCH', `/api/admin/stores/alpha/users/${staff.data.user_id}`, { cookie: admin, body: { status: 'disabled' } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: login.cookie })).status, 401);
  assert.equal((await call(env, 'PATCH', `/api/admin/stores/alpha/users/${staff.data.user_id}`, { cookie: admin, body: { status: 'active' } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { cookie: a.cookie })).status, 200);
});

test('不能停用或刪除店裡唯一一位啟用中的負責人；跨店不可動', async () => {
  const env = createEnv();
  const a = await seedStore(env, { id: 'alpha', name: '甲店' });
  const b = await seedStore(env, { id: 'beta', name: '乙店' });
  const admin = await adminLogin(env);
  assert.equal((await call(env, 'PATCH', `/api/admin/stores/alpha/users/${a.userId}`, { cookie: admin, body: { status: 'disabled' } })).status, 409);
  const second = await invite(env, admin, '第二位負責人', 'owner');
  assert.equal((await call(env, 'PATCH', `/api/admin/stores/alpha/users/${a.userId}`, { cookie: admin, body: { status: 'disabled' } })).status, 200);
  // 用甲店的路徑去動乙店的使用者 → 找不到
  assert.equal((await call(env, 'PATCH', `/api/admin/stores/alpha/users/${b.userId}`, { cookie: admin, body: { status: 'disabled' } })).status, 404);
  assert.equal((await call(env, 'DELETE', `/api/admin/stores/alpha/users/${b.userId}`, { cookie: admin })).status, 404);
  assert.equal((await call(env, 'PATCH', `/api/admin/stores/alpha/users/${second.data.user_id}`, { cookie: admin, body: { status: 'bad' } })).status, 400);
});

test('未綁定但已有操作紀錄的使用者不能刪除', async () => {
  const env = createEnv();
  await seedStore(env, { id: 'alpha', name: '甲店' });
  const admin = await adminLogin(env);
  const user = await invite(env, admin, '有紀錄的');
  env.DB.raw.prepare(`INSERT INTO audit_log (id, store_id, user_id, actor_kind, action, entity, at) VALUES ('x1', 'alpha', ?, 'user', 'test', 'test', '2026-11-24T00:00:00Z')`).run(user.data.user_id);
  assert.equal((await call(env, 'DELETE', `/api/admin/stores/alpha/users/${user.data.user_id}`, { cookie: admin })).status, 409);
});

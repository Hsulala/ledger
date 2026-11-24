import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createEnv, seedStore } from './helpers/app.js';

// 剛匯入、還沒有任何單據的客戶：清單不會列出，但仍然要能開啟單張對帳單、設定結帳日與稅率、填期初餘額
test('沒有交易的新客戶也能設定結帳日、稅率與期初餘額', async () => {
  const env = createEnv();
  const s = await seedStore(env, { id: 'alpha', name: '甲店' });
  const cid = s.companyIds['翔慧'];
  const mod = await call(env, 'POST', '/api/admin/login', { body: { username: 'admin', password: 'admin-password-1' } });
  assert.equal((await call(env, 'PUT', '/api/admin/stores/alpha/modules', { cookie: mod.cookie, body: { modules: { customerStatements: true } } })).status, 200);

  const list = await call(env, 'GET', `/api/c/${cid}/statements?month=2026-10`, { cookie: s.cookie });
  assert.equal(list.status, 200);
  assert.equal(list.data.rows.length, 0);

  const one = await call(env, 'GET', `/api/c/${cid}/statement?customer_id=${s.customer}&month=2026-10`, { cookie: s.cookie });
  assert.equal(one.status, 200);
  assert.equal(one.data.customer.id, s.customer);

  assert.equal((await call(env, 'PUT', `/api/master/customers/${s.customer}`, { cookie: s.cookie, body: { billing_day: 25, tax_rate_pct: 5 } })).status, 200);
  assert.equal((await call(env, 'PUT', `/api/c/${cid}/customer-opening`, { cookie: s.cookie, body: { customer_id: s.customer, as_of: '2026-09-25', amount: 43082 } })).status, 200);
  const after = await call(env, 'GET', `/api/c/${cid}/statement?customer_id=${s.customer}&month=2026-10`, { cookie: s.cookie });
  assert.equal(after.data.customer.billing_day, 25);
  assert.equal(after.data.prev_balance, 43082);
  const listed = await call(env, 'GET', `/api/c/${cid}/statements?month=2026-10`, { cookie: s.cookie });
  assert.equal(listed.data.rows.length, 1); // 有欠款後清單就會列出
});

// 所有 API 路由。auth 選項：'none' 不需登入；'admin' 後台；'store' 店家使用者；'owner' 店家負責人。
import { createRouter } from './router.js';
import { HttpError, json, nowIso, randomToken, sha256Hex, isHexColor } from './util.js';
import { hashPassword, verifyPassword } from './auth/password.js';
import { clearCookie, issueSession } from './auth/session.js';
import { blockedMs, clearFailures, recordFailure } from './auth/limiter.js';
import { authorizeUrl, exchangeCode, lineConfig, verifyIdToken } from './auth/line.js';
import { MODULE_KEYS, MODULES, getModules } from './modules.js';
import { MASTER_KINDS, checkReferences, parseDocument, parseFileIds, parseMaster } from './validate.js';
import { KINDS, confirmDocument, createDocument, findDuplicates, getDocument, listDocuments, updateDocument } from './db/documents.js';
import { checkLink, readFile, signLink, uploadFiles } from './files.js';
import { learnAliases } from './db/ai.js';
import { overview } from './db/overview.js';
import { insertMaster, splitByExisting } from './db/import.js';
import { setOpening } from './db/statements.js';
import { MONTH_RE, statementList, statementOf } from './statement/service.js';
import { NORMALIZERS } from './import/master.js';
import { DEFAULT_MONTHLY_LIMIT, SETTING_LIMIT, rebuild, recognize, usageOf } from './ai/recognize.js';

export const router = createRouter();
const add = (method, path, auth, handler) => router.add(method, path, { auth }, handler);

const HOST_RE = /^(?=.{4,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
function parseHost(value) {
  if (value === null || value === '') return null;
  const host = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!HOST_RE.test(host)) throw new HttpError(400, '專屬網址只能填主機名稱，例如 mamie.kulalab.app（不含 https:// 與路徑）');
  return host;
}
// 綁定連結與登入必須走正確的網址：專屬網址的店只能從自己的網址；沒有專屬網址的店只能從通用網址
const wrongHost = (ctx, storeId, storeHost) => (ctx.hostStore ? ctx.hostStore.id !== storeId : Boolean(storeHost));
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const clientIp = (request) => request.headers.get('cf-connecting-ip') ?? 'local';

async function readJson(request) {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 1_000_000) throw new HttpError(413, '資料太大');
  try { return await request.json(); } catch { throw new HttpError(400, '資料格式不正確'); }
}
const withCookie = (response, ...cookies) => { for (const c of cookies) response.headers.append('set-cookie', c); return response; };

// 依登入者的店家取得 scope；公司路徑上的 :cid 必須是這家店的公司
async function companyScope(ctx) {
  const store = ctx.auth.store.id;
  const company = await ctx.db.scope(store).get('companies', ctx.params.cid);
  if (!company || !company.active) throw new HttpError(404, '找不到這家買方公司');
  return ctx.db.scope(store, company.id);
}
async function requireModule(ctx, key) {
  const modules = await getModules(ctx.db, ctx.auth.store.id);
  if (!modules[key]?.enabled) throw new HttpError(403, `這家店尚未開通「${MODULES[key].label}」`);
}

// ---------- 公開 ----------
add('GET', '/api/health', 'none', () => ({ ok: true }));

// ---------- 後台（管理者）----------
add('POST', '/api/admin/login', 'none', async (ctx) => {
  const { username, password } = await readJson(ctx.request);
  const ipKey = `admin:${clientIp(ctx.request)}`, userKey = `admin-user:${String(username).slice(0, 40)}`;
  for (const key of [ipKey, userKey]) {
    const wait = await blockedMs(ctx.db, key);
    if (wait) throw new HttpError(429, `嘗試次數過多，請 ${Math.ceil(wait / 60000)} 分鐘後再試`);
  }
  let admin = typeof username === 'string' ? await ctx.db.system.getAdminByName(username) : null;
  // 第一次登入：資料庫還沒有任何管理者，且帳密吻合 secret 設定，就建立
  if (!admin && (await ctx.db.system.countAdmins()) === 0 && ctx.env.ADMIN_PASSWORD
    && username === (ctx.env.ADMIN_USERNAME || 'admin') && password === ctx.env.ADMIN_PASSWORD) {
    await ctx.db.system.createAdmin(username, await hashPassword(password));
    admin = await ctx.db.system.getAdminByName(username);
  }
  if (!admin || typeof password !== 'string' || !(await verifyPassword(password, admin.password_hash))) {
    await recordFailure(ctx.db, ipKey); await recordFailure(ctx.db, userKey);
    throw new HttpError(401, '帳號或密碼不正確');
  }
  await clearFailures(ctx.db, ipKey); await clearFailures(ctx.db, userKey);
  return withCookie(json({ ok: true }), await issueSession(ctx.db, 'admin', { adminId: admin.id }, ctx.url));
});
add('POST', '/api/admin/logout', 'admin', async (ctx) => {
  await ctx.db.system.deleteSession(ctx.auth.tokenHash);
  return withCookie(json({ ok: true }), clearCookie('admin', ctx.url));
});
add('GET', '/api/admin/stores', 'admin', async (ctx) => ({ stores: await ctx.db.system.listStores(), module_keys: MODULE_KEYS }));
add('POST', '/api/admin/stores', 'admin', async (ctx) => {
  const { id, name, theme_color: themeColor, host } = await readJson(ctx.request);
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{1,29}$/.test(id)) throw new HttpError(400, '店家代號需為 2 到 30 個小寫英數字（可含 - _），且以英文字母開頭');
  if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new HttpError(400, '請填寫店家名稱（60 字內）');
  if (themeColor && !isHexColor(themeColor)) throw new HttpError(400, '主題色需為 #rrggbb（小寫）');
  const parsedHost = parseHost(host ?? null);
  await ctx.db.system.createStore({ id, name: name.trim(), themeColor: themeColor || null, host: parsedHost });
  await ctx.db.system.audit(id, { actorKind: 'admin', action: 'store.create', entity: 'store', entityId: id });
  return json({ id }, 201);
});
add('PATCH', '/api/admin/stores/:id', 'admin', async (ctx) => {
  const body = await readJson(ctx.request);
  if (body.theme_color && !isHexColor(body.theme_color)) throw new HttpError(400, '主題色需為 #rrggbb（小寫）');
  if (body.status && !['active', 'paused', 'ended'].includes(body.status)) throw new HttpError(400, '狀態不正確');
  const host = body.host === undefined ? undefined : parseHost(body.host);
  const n = await ctx.db.system.updateStore(ctx.params.id, { name: body.name, status: body.status, themeColor: body.theme_color === undefined ? undefined : body.theme_color || null, host });
  if (!n) throw new HttpError(404, '找不到這家店');
  await ctx.db.system.audit(ctx.params.id, { actorKind: 'admin', action: 'store.update', entity: 'store', entityId: ctx.params.id, detail: body });
  return { ok: true };
});
add('GET', '/api/admin/stores/:id/modules', 'admin', async (ctx) => ({ modules: await getModules(ctx.db, ctx.params.id) }));
add('PUT', '/api/admin/stores/:id/modules', 'admin', async (ctx) => {
  const body = await readJson(ctx.request);
  const changes = {};
  for (const [key, value] of Object.entries(body.modules ?? {})) {
    if (!MODULES[key]) throw new HttpError(400, `沒有這個子功能：${key}`);
    if (typeof value !== 'boolean') throw new HttpError(400, `${key} 必須是開或關`);
    if (value && !MODULES[key].supported) throw new HttpError(400, `「${MODULES[key].label}」這一版尚未支援，不能開啟`);
    changes[key] = value;
  }
  if (!(await ctx.db.system.getStore(ctx.params.id))) throw new HttpError(404, '找不到這家店');
  await ctx.db.system.setModules(ctx.params.id, changes);
  await ctx.db.system.audit(ctx.params.id, { actorKind: 'admin', action: 'modules.update', entity: 'store', entityId: ctx.params.id, detail: changes });
  return { modules: await getModules(ctx.db, ctx.params.id) };
});
// 後台以店家負責人身分預覽（2 小時）。以該店第一位啟用中的負責人建立店家端階段，並留稽核紀錄。
// 預覽中做的操作會以該負責人名義留下紀錄。
add('POST', '/api/admin/stores/:id/preview', 'admin', async (ctx) => {
  const store = await ctx.db.system.getStore(ctx.params.id);
  if (!store) throw new HttpError(404, '找不到這家店');
  if (store.status !== 'active') throw new HttpError(409, '這家店目前不是啟用狀態');
  const owner = (await ctx.db.system.listUsers(ctx.params.id)).find((u) => u.role === 'owner' && u.status === 'active');
  if (!owner) throw new HttpError(409, '請先在這家店建立一位負責人');
  await ctx.db.system.audit(ctx.params.id, { actorKind: 'admin', userId: owner.id, action: 'admin.preview', entity: 'store_user', entityId: owner.id });
  return withCookie(json({ ok: true }), await issueSession(ctx.db, 'store', { storeId: ctx.params.id, userId: owner.id }, ctx.url, 2 * 3600));
});
add('GET', '/api/admin/stores/:id/ai', 'admin', async (ctx) => {
  if (!(await ctx.db.system.getStore(ctx.params.id))) throw new HttpError(404, '找不到這家店');
  return { ...(await usageOf(ctx.db, ctx.params.id)), default_limit: DEFAULT_MONTHLY_LIMIT };
});
add('PUT', '/api/admin/stores/:id/ai', 'admin', async (ctx) => {
  if (!(await ctx.db.system.getStore(ctx.params.id))) throw new HttpError(404, '找不到這家店');
  const { limit } = await readJson(ctx.request);
  if (!Number.isInteger(limit) || limit < 0 || limit > 100000) throw new HttpError(400, '每月上限必須是 0 到 100000 的整數');
  await ctx.db.system.setSetting(ctx.params.id, SETTING_LIMIT, limit);
  await ctx.db.system.audit(ctx.params.id, { actorKind: 'admin', action: 'ai.limit', entity: 'store', entityId: ctx.params.id, detail: { limit } });
  return { ...(await usageOf(ctx.db, ctx.params.id)) };
});
// 鼎新主檔匯入：先預覽（commit 不為 true，只回報告，不寫入），確認後再送一次 commit:true 才寫入。
// 一次一種主檔（vendors／products／customers），避免單次請求太大。已存在的資料略過、不覆蓋。
add('POST', '/api/admin/stores/:id/import/:kind', 'admin', async (ctx) => {
  const kind = ctx.params.kind;
  if (!NORMALIZERS[kind]) throw new HttpError(404, '找不到');
  if (!(await ctx.db.system.getStore(ctx.params.id))) throw new HttpError(404, '找不到這家店');
  const body = await readJson(ctx.request);
  if (!Array.isArray(body.rows) || body.rows.length > 5000) throw new HttpError(400, '資料格式不正確（一次最多 5000 列）');
  const { rows, issues } = NORMALIZERS[kind](body.rows);
  const s = ctx.db.scope(ctx.params.id);
  const { fresh, existing } = await splitByExisting(s, kind, rows);
  const report = { kind, total: body.rows.length, importable: rows.length, new: fresh.length, existing: existing.length, issues };
  if (body.commit !== true) return report;
  await insertMaster(s, kind, fresh);
  await ctx.db.system.audit(ctx.params.id, { actorKind: 'admin', action: 'import.master', entity: kind, detail: { new: fresh.length, existing: existing.length } });
  return { ...report, committed: true };
});
add('GET', '/api/admin/stores/:id/users', 'admin', async (ctx) => ({ users: await ctx.db.system.listUsers(ctx.params.id) }));
// 建立店家使用者並產生一次性綁定連結（7 天有效）。連結只會在這一次回應中出現。
add('POST', '/api/admin/stores/:id/users', 'admin', async (ctx) => {
  const { display_name: displayName, role = 'owner' } = await readJson(ctx.request);
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 40) throw new HttpError(400, '請填寫使用者名稱');
  if (!['owner', 'staff'].includes(role)) throw new HttpError(400, '角色不正確');
  const store = await ctx.db.system.getStore(ctx.params.id);
  if (!store) throw new HttpError(404, '找不到這家店');
  const token = randomToken(32);
  const userId = await ctx.db.system.createUserWithInvite({
    storeId: ctx.params.id, displayName: displayName.trim(), role, tokenHash: await sha256Hex(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
  });
  await ctx.db.system.audit(ctx.params.id, { actorKind: 'admin', action: 'user.invite', entity: 'store_user', entityId: userId });
  return json({ user_id: userId, link: `${store.host ? `https://${store.host}` : ctx.url.origin}/auth/line/start?invite=${token}` }, 201);
});

// ---------- LINE 登入 ----------
add('GET', '/auth/line/start', 'none', async (ctx) => {
  const cfg = lineConfig(ctx.env);
  const invite = ctx.url.searchParams.get('invite');
  let inviteTokenHash = null;
  if (invite) {
    inviteTokenHash = await sha256Hex(invite);
    const row = await ctx.db.system.getInvite(inviteTokenHash);
    if (!row || row.used_at || row.expires_at <= nowIso() || row.store_status !== 'active' || wrongHost(ctx, row.store_id, row.store_host)) throw new HttpError(400, '這個綁定連結無效或已使用，請向管理者重新索取');
  }
  const state = randomToken(24), nonce = randomToken(16);
  await ctx.db.system.saveOauthState({ stateHash: await sha256Hex(state), nonce, inviteTokenHash, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  const redirectUri = `${ctx.url.origin}/auth/line/callback`;
  return new Response(null, { status: 302, headers: { location: authorizeUrl({ channelId: cfg.channelId, redirectUri, state, nonce }), 'cache-control': 'no-store' } });
});
add('GET', '/auth/line/callback', 'none', async (ctx) => {
  const fail = (code) => new Response(null, { status: 302, headers: { location: `/?login_error=${code}`, 'cache-control': 'no-store' } });
  const code = ctx.url.searchParams.get('code'), state = ctx.url.searchParams.get('state');
  if (!code || !state) return fail('cancelled');
  const saved = await ctx.db.system.takeOauthState(await sha256Hex(state));
  if (!saved) return fail('state');
  let identity;
  try { identity = await exchangeCode(lineConfig(ctx.env), { code, redirectUri: `${ctx.url.origin}/auth/line/callback`, nonce: saved.nonce }); } catch { return fail('line'); }

  let user;
  if (saved.invite_token_hash) {
    const invite = await ctx.db.system.getInvite(saved.invite_token_hash);
    if (!invite || invite.used_at || invite.expires_at <= nowIso() || wrongHost(ctx, invite.store_id, invite.store_host)) return fail('invite');
    if (!(await ctx.db.system.bindInvite(invite, identity.lineUserId))) return fail('bind');
    user = await ctx.db.system.getUser(invite.user_id);
    await ctx.db.system.audit(user.store_id, { actorKind: 'user', userId: user.id, action: 'user.bind', entity: 'store_user', entityId: user.id });
  } else {
    // 專屬網址只找該店的使用者；若有多筆，取最近建立的
    user = (await ctx.db.system.findUsersByLine(identity.lineUserId, ctx.hostStore?.id ?? null))[0];
    if (!user) return fail('unbound');
  }
  const cookieValue = await issueSession(ctx.db, 'store', { storeId: user.store_id, userId: user.id }, ctx.url);
  return withCookie(new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } }), cookieValue);
});
// LIFF（LINE 內開網頁）：前端帶 ID token，後端驗證後直接建立登入
add('POST', '/api/auth/liff', 'none', async (ctx) => {
  const { id_token: idToken } = await readJson(ctx.request);
  const identity = await verifyIdToken(lineConfig(ctx.env), idToken, null);
  const user = (await ctx.db.system.findUsersByLine(identity.lineUserId, ctx.hostStore?.id ?? null))[0];
  if (!user) throw new HttpError(403, '這個 LINE 帳號尚未綁定，請向管理者索取綁定連結');
  return withCookie(json({ ok: true }), await issueSession(ctx.db, 'store', { storeId: user.store_id, userId: user.id }, ctx.url));
});
// 本機測試用，只有 DEV_LOGIN=1 且主機是 localhost 才存在
add('POST', '/api/dev/login', 'none', async (ctx) => {
  if (ctx.env.DEV_LOGIN !== '1' || !['localhost', '127.0.0.1'].includes(ctx.url.hostname)) throw new HttpError(404, '找不到');
  const { user_id: userId } = await readJson(ctx.request);
  const user = await ctx.db.system.getUser(userId);
  if (!user) throw new HttpError(404, '找不到使用者');
  return withCookie(json({ ok: true }), await issueSession(ctx.db, 'store', { storeId: user.store_id, userId: user.id }, ctx.url));
});
add('POST', '/api/auth/logout', 'store', async (ctx) => {
  await ctx.db.system.deleteSession(ctx.auth.tokenHash);
  return withCookie(json({ ok: true }), clearCookie('store', ctx.url));
});

// ---------- 店家端：基本資料 ----------
add('GET', '/api/me', 'store', async (ctx) => {
  const { user, store } = ctx.auth;
  const companies = await ctx.db.scope(store.id).list('companies', { where: { active: 1 }, order: [['name', 'asc']] });
  return {
    user: { id: user.id, display_name: user.display_name, role: user.role },
    store: { id: store.id, name: store.name, theme_color: store.theme_color },
    modules: await getModules(ctx.db, store.id),
    companies: companies.map(({ id, name, tax_id: taxId }) => ({ id, name, tax_id: taxId })),
  };
});
add('PATCH', '/api/store/theme', 'owner', async (ctx) => {
  const { theme_color: color } = await readJson(ctx.request);
  if (color && !isHexColor(color)) throw new HttpError(400, '主題色需為 #rrggbb（小寫）');
  await ctx.db.system.updateStore(ctx.auth.store.id, { themeColor: color || null });
  await ctx.db.system.audit(ctx.auth.store.id, { actorKind: 'user', userId: ctx.auth.user.id, action: 'theme.update', entity: 'store', entityId: ctx.auth.store.id, detail: { color: color || null } });
  return { ok: true };
});

// ---------- 主檔（買方公司、廠商、商品、客戶、品名對照）----------
add('GET', '/api/master/:kind', 'store', async (ctx) => {
  const cfg = MASTER_KINDS[ctx.params.kind];
  if (!cfg) throw new HttpError(404, '找不到');
  // 匯入鼎新資料後商品、客戶都上千筆，所以分頁讀完整份（單次上限 500）
  const s = ctx.db.scope(ctx.auth.store.id);
  const rows = [];
  for (let offset = 0; offset < 10000; offset += 500) {
    const page = await s.list(cfg.table, { order: cfg.searchOrder, limit: 500, offset });
    rows.push(...page);
    if (page.length < 500) break;
  }
  return { rows };
});
add('POST', '/api/master/:kind', 'owner', async (ctx) => {
  const cfg = MASTER_KINDS[ctx.params.kind];
  if (!cfg) throw new HttpError(404, '找不到');
  const s = ctx.db.scope(ctx.auth.store.id);
  const data = parseMaster(ctx.params.kind, await readJson(ctx.request), { partial: false });
  await checkMasterRefs(s, ctx.params.kind, data);
  const id = await s.create(cfg.table, { ...data, created_at: nowIso() });
  return json({ id }, 201);
});
add('PUT', '/api/master/:kind/:id', 'owner', async (ctx) => {
  const cfg = MASTER_KINDS[ctx.params.kind];
  if (!cfg) throw new HttpError(404, '找不到');
  const s = ctx.db.scope(ctx.auth.store.id);
  const data = parseMaster(ctx.params.kind, await readJson(ctx.request), { partial: true });
  await checkMasterRefs(s, ctx.params.kind, data);
  if (!Object.keys(data).length) throw new HttpError(400, '沒有要更新的欄位');
  if (!(await s.update(cfg.table, ctx.params.id, data))) throw new HttpError(404, '找不到');
  return { ok: true };
});
async function checkMasterRefs(s, kind, data) {
  if (kind !== 'aliases') return;
  if (data.vendor_id && !(await s.get('vendors', data.vendor_id))) throw new HttpError(400, '找不到這家廠商', { fields: { vendor_id: '找不到這家廠商' } });
  if (data.product_id && !(await s.get('products', data.product_id))) throw new HttpError(400, '找不到這個商品', { fields: { product_id: '找不到這個商品' } });
}

// ---------- 檔案 ----------
add('POST', '/api/c/:cid/files', 'store', async (ctx) => {
  const s = await companyScope(ctx);
  await requireModule(ctx, 'purchaseOrders');
  return json({ files: await uploadFiles({ env: ctx.env, scope: s, userId: ctx.auth.user.id, request: ctx.request }) }, 201);
});
add('GET', '/api/files/:fid/link', 'store', async (ctx) => {
  const file = await ctx.db.scope(ctx.auth.store.id).get('source_files', ctx.params.fid);
  if (!file) throw new HttpError(404, '找不到檔案');
  return { url: await signLink(ctx.env, ctx.auth.store.id, file.id), mime: file.mime };
});
add('GET', '/f/:fid', 'store', async (ctx) => {
  const exp = ctx.url.searchParams.get('exp'), sig = ctx.url.searchParams.get('sig');
  if (!(await checkLink(ctx.env, ctx.auth.store.id, ctx.params.fid, exp, sig))) throw new HttpError(403, '連結無效或已過期');
  const file = await ctx.db.scope(ctx.auth.store.id).get('source_files', ctx.params.fid);
  const response = file && (await readFile(ctx.env, file));
  if (!response) throw new HttpError(404, '找不到檔案');
  return response;
});

// ---------- 待確認、進貨單、訂單 ----------
// ---------- 單據判讀（AI 只讀欄位；金額、日期換算與比對由程式處理；產生的一律是草稿）----------
add('GET', '/api/c/:cid/ai-usage', 'store', async (ctx) => {
  await companyScope(ctx);
  const modules = await getModules(ctx.db, ctx.auth.store.id);
  return { enabled: modules.documentRecognition.enabled, ...(await usageOf(ctx.db, ctx.auth.store.id)) };
});
add('POST', '/api/c/:cid/recognize', 'store', async (ctx) => {
  const s = await companyScope(ctx);
  await requireModule(ctx, 'purchaseOrders');
  await requireModule(ctx, 'documentRecognition');
  const body = await readJson(ctx.request);
  const result = await recognize({ env: ctx.env, db: ctx.db, scope: s, store: ctx.auth.store, userId: ctx.auth.user.id, fileIds: parseFileIds(body), fetchImpl: ctx.env.FETCH_IMPL });
  return json(result);
});
add('POST', '/api/c/:cid/extractions/:eid/build', 'store', async (ctx) => {
  const s = await companyScope(ctx);
  await requireModule(ctx, 'purchaseOrders');
  return json(await rebuild({ scope: s, db: ctx.db, store: ctx.auth.store, userId: ctx.auth.user.id, extractionId: ctx.params.eid }));
});

add('GET', '/api/c/:cid/pending', 'store', async (ctx) => {
  const s = await companyScope(ctx);
  await requireModule(ctx, 'purchaseOrders');
  const [purchases, orders, files] = await Promise.all([
    s.list('purchases', { where: { status: 'draft' }, order: [['created_at', 'desc']], limit: 200 }),
    s.list('orders', { where: { status: 'draft' }, order: [['created_at', 'desc']], limit: 200 }),
    s.list('source_files', { where: { status: 'pending', doc_id: null }, order: [['created_at', 'desc']], limit: 200 }),
  ]);
  return { purchases, orders, files };
});

// ---------- 總覽與跨公司清單（唯讀；仍只限這家店）----------
// ---------- 客戶對帳單（應收）----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
async function statementCtx(ctx) {
  const s = await companyScope(ctx);
  await requireModule(ctx, 'customerStatements');
  const month = ctx.url.searchParams.get('month') ?? '';
  if (!MONTH_RE.test(month)) throw new HttpError(400, '月份格式必須是 YYYY-MM');
  return { s, month };
}
add('GET', '/api/c/:cid/statements', 'store', async (ctx) => {
  const { s, month } = await statementCtx(ctx);
  return { month, rows: await statementList(s, month) };
});
add('GET', '/api/c/:cid/statement', 'store', async (ctx) => {
  const { s, month } = await statementCtx(ctx);
  const customerId = ctx.url.searchParams.get('customer_id') ?? '';
  const result = customerId ? await statementOf(s, customerId, month) : null;
  if (!result) throw new HttpError(404, '找不到這個客戶');
  const company = await ctx.db.scope(ctx.auth.store.id).get('companies', ctx.params.cid);
  return { company: { id: company.id, name: company.name, tax_id: company.tax_id }, prepared_by: ctx.auth.user.display_name, ...result };
});
add('POST', '/api/c/:cid/customer-payments', 'store', async (ctx) => {
  const s = await companyScope(ctx);
  await requireModule(ctx, 'customerStatements');
  const b = await readJson(ctx.request);
  if (!(await s.allCompanies().get('customers', b.customer_id))) throw new HttpError(400, '找不到這個客戶', { fields: { customer_id: '找不到這個客戶' } });
  if (!DATE_RE.test(b.paid_on ?? '')) throw new HttpError(400, '收款日期格式必須是 YYYY-MM-DD', { fields: { paid_on: '日期格式不正確' } });
  if (!Number.isInteger(b.amount) || b.amount <= 0 || b.amount > 1_000_000_000) throw new HttpError(400, '金額必須是大於 0 的整數', { fields: { amount: '金額必須是大於 0 的整數' } });
  const id = await s.create('customer_payments', { customer_id: b.customer_id, paid_on: b.paid_on, amount: b.amount, method: String(b.method ?? '').slice(0, 20), note: String(b.note ?? '').slice(0, 200), created_at: nowIso() });
  await ctx.db.system.audit(ctx.auth.store.id, { actorKind: 'user', userId: ctx.auth.user.id, action: 'payment.create', entity: 'customer_payment', entityId: id, detail: { customer_id: b.customer_id, paid_on: b.paid_on, amount: b.amount } });
  return json({ id }, 201);
});
add('DELETE', '/api/c/:cid/customer-payments/:pid', 'owner', async (ctx) => {
  const s = await companyScope(ctx);
  await requireModule(ctx, 'customerStatements');
  const row = await s.get('customer_payments', ctx.params.pid);
  if (!row) throw new HttpError(404, '找不到這筆收款');
  await s.deleteStmt('customer_payments', row.id).run();
  await ctx.db.system.audit(ctx.auth.store.id, { actorKind: 'user', userId: ctx.auth.user.id, action: 'payment.delete', entity: 'customer_payment', entityId: row.id, detail: { customer_id: row.customer_id, paid_on: row.paid_on, amount: row.amount } });
  return { ok: true };
});
add('PUT', '/api/c/:cid/customer-opening', 'owner', async (ctx) => {
  const s = await companyScope(ctx);
  await requireModule(ctx, 'customerStatements');
  const b = await readJson(ctx.request);
  if (!(await s.allCompanies().get('customers', b.customer_id))) throw new HttpError(400, '找不到這個客戶');
  if (!DATE_RE.test(b.as_of ?? '')) throw new HttpError(400, '截至日期格式必須是 YYYY-MM-DD');
  if (!Number.isInteger(b.amount) || Math.abs(b.amount) > 1_000_000_000) throw new HttpError(400, '金額必須是整數');
  await setOpening(s, { customerId: b.customer_id, asOf: b.as_of, amount: b.amount, at: nowIso() });
  await ctx.db.system.audit(ctx.auth.store.id, { actorKind: 'user', userId: ctx.auth.user.id, action: 'opening.set', entity: 'customer_opening', entityId: b.customer_id, detail: { as_of: b.as_of, amount: b.amount } });
  return { ok: true };
});

add('GET', '/api/overview', 'store', async (ctx) => {
  await requireModule(ctx, 'purchaseOrders');
  const month = ctx.url.searchParams.get('month') ?? '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'month 格式必須是 YYYY-MM');
  return { month, ...(await overview(ctx.db.scope(ctx.auth.store.id), month)) };
});

const listOptions = (q) => ({
  status: ['draft', 'confirmed'].includes(q.get('status')) ? q.get('status') : undefined,
  vendorId: q.get('vendor_id') || undefined, customerId: q.get('customer_id') || undefined,
  from: q.get('from') || undefined, to: q.get('to') || undefined, q: (q.get('q') ?? '').trim().slice(0, 40) || undefined,
  limit: Math.min(Number(q.get('limit')) || 50, 200), offset: Number(q.get('offset')) || 0,
});

for (const kind of Object.keys(KINDS)) {
  const base = `/api/c/:cid/${kind === 'purchase' ? 'purchases' : 'orders'}`;

  add('GET', `/api/all/${kind === 'purchase' ? 'purchases' : 'orders'}`, 'store', async (ctx) => {
    await requireModule(ctx, 'purchaseOrders');
    return listDocuments(ctx.db.scope(ctx.auth.store.id), kind, listOptions(ctx.url.searchParams));
  });
  add('GET', base, 'store', async (ctx) => {
    const s = await companyScope(ctx);
    await requireModule(ctx, 'purchaseOrders');
    return listDocuments(s, kind, listOptions(ctx.url.searchParams));
  });
  add('GET', `${base}/:id`, 'store', async (ctx) => {
    const s = await companyScope(ctx);
    await requireModule(ctx, 'purchaseOrders');
    const doc = await getDocument(s, kind, ctx.params.id);
    if (!doc) throw new HttpError(404, '找不到這張單據');
    return doc;
  });
  add('POST', base, 'store', async (ctx) => {
    const s = await companyScope(ctx);
    await requireModule(ctx, 'purchaseOrders');
    const body = await readJson(ctx.request);
    const { header, items } = parseDocument(kind, body);
    await checkReferences(kind, s, header, items);
    const fileIds = await checkFiles(s, parseFileIds(body));
    return json({ id: await createDocument(s, kind, { header, items, fileIds }, ctx.auth.user.id) }, 201);
  });
  add('PUT', `${base}/:id`, 'store', async (ctx) => {
    const s = await companyScope(ctx);
    await requireModule(ctx, 'purchaseOrders');
    const body = await readJson(ctx.request);
    const { header, items } = parseDocument(kind, body);
    await checkReferences(kind, s, header, items);
    const fileIds = await checkFiles(s, parseFileIds(body));
    if (!(await updateDocument(s, kind, ctx.params.id, { header, items, fileIds }, ctx.auth.user.id))) {
      throw new HttpError((await s.get(KINDS[kind].table, ctx.params.id)) ? 409 : 404, '只有草稿可以修改，已確認入帳的單據不能改');
    }
    return { ok: true };
  });
  add('POST', `${base}/:id/confirm`, 'store', async (ctx) => {
    const s = await companyScope(ctx);
    await requireModule(ctx, 'purchaseOrders');
    const body = await readJson(ctx.request).catch(() => ({}));
    const doc = await getDocument(s, kind, ctx.params.id);
    if (!doc) throw new HttpError(404, '找不到這張單據');
    if (doc.status === 'confirmed') throw new HttpError(409, '這張單據已經確認入帳');
    // 以資料庫裡的草稿內容驗證完整性（驗證規則與儲存時相同，再加上確認入帳的必填）
    parseDocument(kind, { ...doc, flags: JSON.parse(doc.flags || '{}'), items: doc.items.map((i) => ({ ...i, flags: JSON.parse(i.flags || '{}') })) }, { forConfirm: true });
    if (Object.keys(JSON.parse(doc.flags || '{}')).length || doc.items.some((i) => Object.keys(JSON.parse(i.flags || '{}')).length)) {
      throw new HttpError(409, '還有標黃的欄位尚未確認，請先檢查或按「這些都沒錯」');
    }
    const duplicates = await findDuplicates(s, kind, doc, doc.id);
    if (duplicates.length && body.acknowledge_duplicate !== true) throw new HttpError(409, '已有相同單號的單據，請確認是否重複', { duplicates });
    if (!(await confirmDocument(s, kind, doc.id, ctx.auth.user.id))) throw new HttpError(409, '這張單據已經確認入帳');
    if (kind === 'purchase') await learnAliases(s, doc.vendor_id, doc.items).catch(() => {});
    return { ok: true };
  });
}

// 附上的檔案必須是這家店、這家公司的待處理檔案
async function checkFiles(s, ids) {
  if (!ids.length) return ids;
  const found = await s.list('source_files', { in: { id: ids }, limit: 50 });
  if (found.length !== ids.length) throw new HttpError(400, '有檔案不存在或不屬於這家買方公司', { fields: { file_ids: '檔案不正確' } });
  return ids;
}



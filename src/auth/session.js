// 登入階段：權杖隨機產生、資料庫只存雜湊。後台與店家使用不同的 Cookie。
import { cookie, nowIso, randomToken, readCookie, sha256Hex } from '../util.js';

export const ADMIN_COOKIE = 'ledger_admin';
export const STORE_COOKIE = 'ledger_session';
const TTL_SEC = { admin: 12 * 3600, store: 14 * 24 * 3600 };

export async function issueSession(db, kind, ids, url) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + TTL_SEC[kind] * 1000).toISOString();
  await db.system.createSession({ tokenHash: await sha256Hex(token), kind, ...ids, expiresAt });
  const name = kind === 'admin' ? ADMIN_COOKIE : STORE_COOKIE;
  return cookie(name, token, { maxAgeSec: TTL_SEC[kind], secure: url.protocol === 'https:' });
}

export const clearCookie = (kind, url) =>
  cookie(kind === 'admin' ? ADMIN_COOKIE : STORE_COOKIE, '', { maxAgeSec: 0, secure: url.protocol === 'https:' });

async function load(db, request, kind) {
  const token = readCookie(request.headers.get('cookie'), kind === 'admin' ? ADMIN_COOKIE : STORE_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.system.getSession(tokenHash);
  if (!row || row.kind !== kind || row.expires_at <= nowIso()) return null;
  return { row, tokenHash };
}

export async function authenticateAdmin(db, request) {
  const hit = await load(db, request, 'admin');
  return hit ? { adminId: hit.row.admin_id, tokenHash: hit.tokenHash } : null;
}

// 店家使用者：店家與帳號都必須仍是啟用狀態，停用後既有登入立刻失效
export async function authenticateStore(db, request) {
  const hit = await load(db, request, 'store');
  if (!hit) return null;
  const user = await db.system.getUser(hit.row.user_id);
  const store = user && (await db.system.getStore(user.store_id));
  if (!user || user.status !== 'active' || !store || store.status !== 'active' || user.store_id !== hit.row.store_id) return null;
  return { user, store, tokenHash: hit.tokenHash };
}

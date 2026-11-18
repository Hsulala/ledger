// Cloudflare Workers 入口：路由、登入檢查、錯誤處理、靜態頁面。
import { getDb } from './db/index.js';
import { router } from './routes.js';
import { authenticateAdmin, authenticateStore } from './auth/session.js';
import { HttpError, json } from './util.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const API_PREFIXES = ['/api/', '/auth/', '/f/'];

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
};

function withHeaders(response) {
  const next = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!next.headers.has(k)) next.headers.set(k, v);
  return next;
}

function errorResponse(error) {
  if (error instanceof HttpError) return json({ error: error.message, ...error.extra }, error.status);
  const message = String(error?.message ?? error);
  // 資料庫限制：重複、外鍵、檢查（把底層錯誤轉成使用者看得懂的回應，不外洩 SQL）
  if (/UNIQUE constraint failed/i.test(message)) return json({ error: '資料重複，已有相同名稱或代號' }, 409);
  if (/FOREIGN KEY constraint failed/i.test(message)) return json({ error: '資料有誤：引用的項目不存在' }, 400);
  if (/CHECK constraint failed|NOT NULL constraint failed/i.test(message)) return json({ error: '資料有誤，請檢查欄位內容' }, 400);
  console.error('未處理的錯誤', message);
  return json({ error: '系統發生錯誤，請稍後再試' }, 500);
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const isApi = API_PREFIXES.some((p) => url.pathname.startsWith(p));
  if (!isApi) {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  }

  // 防跨站請求：有 Origin 的寫入請求，必須與本站相同
  if (UNSAFE.has(request.method)) {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, '來源不允許');
  }

  const matched = router.match(request.method, url.pathname);
  if (!matched) throw new HttpError(404, '找不到');
  const db = getDb(env);
  const need = matched.route.options.auth;
  const ctx = { request, env, url, db, params: matched.params, auth: null };

  if (need === 'admin') {
    ctx.auth = await authenticateAdmin(db, request);
    if (!ctx.auth) throw new HttpError(401, '請先登入後台');
  } else if (need === 'store' || need === 'owner') {
    ctx.auth = await authenticateStore(db, request);
    if (!ctx.auth) throw new HttpError(401, '請先登入');
    if (need === 'owner' && ctx.auth.user.role !== 'owner') throw new HttpError(403, '只有負責人可以做這個操作');
  }

  const result = await matched.route.handler(ctx);
  return result instanceof Response ? result : json(result);
}

export default {
  async fetch(request, env) {
    try { return withHeaders(await handle(request, env)); } catch (error) { return withHeaders(errorResponse(error)); }
  },
};

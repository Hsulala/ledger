// LINE Login（OAuth 2.1 / OpenID Connect）。網頁與 LIFF 都用同一個 LINE Login channel。
// fetch 可注入（env.fetchImpl），測試時不連外。
import { HttpError } from '../util.js';

const AUTHORIZE = 'https://access.line.me/oauth2/v2.1/authorize';
const TOKEN = 'https://api.line.me/oauth2/v2.1/token';
const VERIFY = 'https://api.line.me/oauth2/v2.1/verify';

export function lineConfig(env) {
  if (!env.LINE_LOGIN_CHANNEL_ID || !env.LINE_LOGIN_CHANNEL_SECRET) throw new HttpError(503, 'LINE 登入尚未設定');
  return { channelId: env.LINE_LOGIN_CHANNEL_ID, channelSecret: env.LINE_LOGIN_CHANNEL_SECRET, fetchImpl: env.fetchImpl ?? ((...a) => fetch(...a)) };
}

export function authorizeUrl({ channelId, redirectUri, state, nonce }) {
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({ response_type: 'code', client_id: channelId, redirect_uri: redirectUri, state, scope: 'openid profile', nonce }).toString();
  return url.toString();
}

const form = (data) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data), signal: AbortSignal.timeout(8000) });

// 以授權碼換 id_token，再請 LINE 驗證並取回 sub（LINE userId）。nonce 必須吻合。
export async function exchangeCode(cfg, { code, redirectUri, nonce }) {
  const tokenRes = await cfg.fetchImpl(TOKEN, form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: cfg.channelId, client_secret: cfg.channelSecret }));
  if (!tokenRes.ok) throw new HttpError(401, 'LINE 授權失敗');
  const { id_token: idToken } = await tokenRes.json();
  return verifyIdToken(cfg, idToken, nonce);
}

export async function verifyIdToken(cfg, idToken, nonce) {
  if (typeof idToken !== 'string' || !idToken) throw new HttpError(401, '缺少 LINE 身分憑證');
  const res = await cfg.fetchImpl(VERIFY, form({ id_token: idToken, client_id: cfg.channelId }));
  if (!res.ok) throw new HttpError(401, 'LINE 身分驗證失敗');
  const payload = await res.json();
  if (!payload.sub) throw new HttpError(401, 'LINE 身分驗證失敗');
  if (nonce && payload.nonce !== nonce) throw new HttpError(401, 'LINE 身分驗證失敗');
  return { lineUserId: payload.sub, name: payload.name ?? '' };
}

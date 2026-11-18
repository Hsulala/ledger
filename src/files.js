// 原始單據檔案：驗證真實格式、去重、存 R2（私有）、發短效簽名連結再由程式代為讀取。
import { HttpError, hmacHex, safeEqual, sha256Hex, nowIso } from './util.js';

export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 20;
const LINK_TTL_SEC = 300;

const startsWith = (bytes, sig, at = 0) => sig.every((b, i) => bytes[at + i] === b);

// 以檔頭判斷真實格式；不信任瀏覽器給的 Content-Type 或副檔名。只收 JPEG、PNG、WebP、PDF（不收 SVG、HTML、壓縮檔）。
export function detectType(bytes) {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { mime: 'image/webp', ext: 'webp' };
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

// 回傳每個檔案的結果；重複的檔案不再存一份，回傳既有的那筆
export async function uploadFiles({ env, scope, userId, request }) {
  if (!env.FILES) throw new HttpError(503, '檔案儲存尚未設定');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES * MAX_FILES_PER_REQUEST) throw new HttpError(413, '上傳內容太大');
  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, '上傳格式不正確'); }
  const files = form.getAll('files').filter((f) => typeof f === 'object' && typeof f.arrayBuffer === 'function');
  if (!files.length) throw new HttpError(400, '沒有收到檔案');
  if (files.length > MAX_FILES_PER_REQUEST) throw new HttpError(400, `一次最多上傳 ${MAX_FILES_PER_REQUEST} 個檔案`);

  const results = [];
  for (const file of files) {
    const name = String(file.name ?? '').slice(0, 120);
    if (file.size > MAX_BYTES) { results.push({ name, error: '檔案超過 15 MB' }); continue; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = detectType(bytes);
    if (!type) { results.push({ name, error: '只接受 JPEG、PNG、WebP 圖片或 PDF' }); continue; }
    const sha = await sha256Hex(bytes);
    const existing = (await scope.allCompanies().list('source_files', { where: { sha256: sha }, limit: 1 }))[0];
    if (existing) { results.push({ name, id: existing.id, duplicate: true, company_id: existing.company_id, status: existing.status }); continue; }
    const key = `stores/${scope.storeId}/files/${sha}.${type.ext}`;
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: type.mime } });
    const id = await scope.create('source_files', {
      r2_key: key, sha256: sha, mime: type.mime, bytes: bytes.length, original_name: name, status: 'pending', uploaded_by: userId, created_at: nowIso(),
    });
    results.push({ name, id, duplicate: false, mime: type.mime, bytes: bytes.length });
  }
  return results;
}

const message = (storeId, fileId, exp) => `file:${storeId}:${fileId}:${exp}`;

export async function signLink(env, storeId, fileId, now = Date.now()) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(503, 'SESSION_SECRET 尚未設定');
  const exp = Math.floor(now / 1000) + LINK_TTL_SEC;
  return `/f/${fileId}?exp=${exp}&sig=${await hmacHex(env.SESSION_SECRET, message(storeId, fileId, exp))}`;
}

// 驗證簽名與期限；呼叫端另外要確認登入者的店家就是檔案所屬店家
export async function checkLink(env, storeId, fileId, exp, sig, now = Date.now()) {
  if (!env.SESSION_SECRET || !/^\d+$/.test(String(exp)) || Number(exp) * 1000 < now) return false;
  return safeEqual(await hmacHex(env.SESSION_SECRET, message(storeId, fileId, exp)), String(sig ?? ''));
}

export async function readFile(env, row) {
  const object = await env.FILES.get(row.r2_key);
  if (!object) return null;
  return new Response(object.body, {
    headers: {
      'content-type': row.mime,
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      // 圖片沿用最嚴格的設定；PDF 要讓瀏覽器內建檢視器能開，所以不加 sandbox
      'content-security-policy': row.mime === 'application/pdf' ? "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'" : "default-src 'none'; img-src 'self' data:; sandbox",
    },
  });
}

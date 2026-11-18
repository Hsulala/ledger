// 判讀結果的程式端處理：日期換算、金額取整、名稱比對。AI 只負責「讀」，這裡的規則決定怎麼用。

const pad = (n) => String(n).padStart(2, '0');
const validDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// 單上的日期寫法 → { date: 'YYYY-MM-DD' | null, uncertain }
// 4 位數 ≥ 1990 視為西元；3 位數（含 0115 這種前導 0）視為民國；2 位數視為 20xx。
export function parseDateText(raw, today = new Date()) {
  const text = String(raw ?? '').trim();
  if (!text) return { date: null, uncertain: true };
  const m = text.match(/(\d{2,4})\s*[./\-年]\s*(\d{1,2})\s*[./\-月]\s*(\d{1,2})/);
  if (!m) return { date: null, uncertain: true };
  let year = Number(m[1]);
  const digits = m[1].replace(/^0+/, '').length;
  let guessed = false;
  if (m[1].length === 4 && year >= 1990) { /* 西元 */ }
  else if (digits === 3 || (m[1].length === 4 && year < 1990)) year += 1911;
  else if (m[1].length === 2) { year += 2000; guessed = Math.abs(year - today.getUTCFullYear()) > 1; }
  else return { date: null, uncertain: true };
  const month = Number(m[2]), day = Number(m[3]);
  if (!validDate(year, month, day)) return { date: null, uncertain: true };
  const limit = new Date(today.getTime() + 366 * 86400000).getUTCFullYear();
  if (year < 2000 || year > limit) return { date: null, uncertain: true };
  return { date: `${year}-${pad(month)}-${pad(day)}`, uncertain: guessed };
}

// 金額一律整數元；不是整數的當作沒讀到並標黃
export function toInt(value) {
  if (value === null || value === undefined || value === '') return { value: null, uncertain: false };
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s$]/g, ''));
  if (!Number.isFinite(n)) return { value: null, uncertain: true };
  if (!Number.isInteger(n)) return { value: Math.round(n), uncertain: true };
  return { value: n, uncertain: false };
}
export function toPriceX100(value) {
  if (value === null || value === undefined || value === '') return { value: null, uncertain: false };
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s$]/g, ''));
  if (!Number.isFinite(n) || n < 0) return { value: null, uncertain: true };
  return { value: Math.round(n * 100), uncertain: false };
}

const COMPANY_WORDS = /(股份有限公司|有限公司|公司|企業|食品|實業|商行|行號)/g;
export const normName = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/[()（）【】\[\]]/g, '').toLowerCase();
const coreName = (s) => normName(s).replace(COMPANY_WORDS, '');

// 以統編優先、再用名稱與別名比對；回傳唯一命中的列，沒命中或有多筆都回 null（不猜）
export function matchParty(rows, { name, taxId }) {
  const list = rows.filter((r) => r.active !== 0);
  if (taxId) {
    const hit = list.filter((r) => r.tax_id && r.tax_id === String(taxId).trim());
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) return null;
  }
  const n = normName(name), core = coreName(name);
  if (!n) return null;
  const names = (r) => [r.name, ...safeList(r.aliases)];
  let hit = list.filter((r) => names(r).some((x) => normName(x) === n));
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) return null;
  if (core.length >= 2) {
    hit = list.filter((r) => names(r).some((x) => { const c = coreName(x); return c.length >= 2 && (c === core || c.includes(core) || core.includes(c)); }));
    if (hit.length === 1) return hit[0];
  }
  return null;
}
function safeList(text) { try { const v = JSON.parse(text ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }

// 品名對照：先看 Mamie 以前確認過的寫法（廠商 + 單上寫法），再用商品名稱完全相同
export function matchProduct(item, { vendorId, aliases, products }) {
  const raw = normName(item.name);
  if (!raw) return null;
  const a = aliases.find((x) => x.vendor_id === vendorId && normName(x.raw_name) === raw);
  if (a) return a.product_id;
  const hit = products.filter((p) => p.active !== 0 && normName(p.name) === raw);
  return hit.length === 1 ? hit[0].id : null;
}

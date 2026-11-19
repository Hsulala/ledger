// 鼎新匯出的主檔（商品、客戶、廠商）整理與檢查。純函式：輸入 Excel 的列（欄名為鼎新的中文標題），輸出要寫入的資料與問題清單。
// 原則：不自動合併、不猜測；有疑問的列出來給人確認。庫存量與標準進價不匯入（資料不可信）。

const BEDDING_GROUPS = new Set(['40支天絲', '50%天絲', '60支天絲', '80支天絲', '100支天絲', '120支天絲', '舒柔棉', '枕頭', '棉被', '純棉', '法蘭絨', '保潔墊', '冰絲系列']);
const READY_MEAL_GROUPS = new Set(['冷凍即食包', '調理包事業']);
const VENDOR_GROUP = { A: '寢具', B: '食品', C: '其他' };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const optional = (v) => str(v) || null;
function taxId(v) {
  const s = str(v).replace(/\.0+$/, '');
  if (!s) return { value: null, bad: false };
  return /^\d{8}$/.test(s) ? { value: s, bad: false } : { value: null, bad: true, raw: s };
}
function cut(text, max) { return text.length > max ? text.slice(0, max) : text; }

function dupGroups(rows, keyOf) {
  const map = new Map();
  for (const r of rows) { const k = keyOf(r); if (!k) continue; (map.get(k) ?? map.set(k, []).get(k)).push(r); }
  return [...map.entries()].filter(([, list]) => list.length > 1);
}

export const KINDS = ['vendors', 'products', 'customers'];

export function normalizeVendors(rows) {
  const issues = [];
  const out = [];
  for (const row of rows) {
    const code = str(row['廠商代號']);
    let name = str(row['廠商簡稱']);
    if (!name) { issues.push({ severity: 'check', kind: 'vendor_no_name', key: code, name: '', detail: '沒有廠商簡稱，未匯入' }); continue; }
    if (name.length > 60) { issues.push({ severity: 'check', kind: 'name_too_long', key: code, name, detail: '名稱超過 60 字，已截斷' }); name = cut(name, 60); }
    const t = taxId(row['統一編號']);
    if (t.bad) issues.push({ severity: 'check', kind: 'bad_tax_id', key: code, name, detail: `統編格式不正確（${t.raw}），未匯入統編` });
    else if (!t.value) issues.push({ severity: 'info', kind: 'no_tax_id', key: code, name, detail: '沒有統編（AI 判讀用統編比對會更準，建議補上）' });
    const aliases = name.includes('/') ? name.split('/').map((x) => x.trim()).filter(Boolean) : [];
    const group = VENDOR_GROUP[code[0]?.toUpperCase()] ?? null;
    out.push({
      legacy_code: code || null, name, aliases: JSON.stringify(aliases), tax_id: t.value, group_name: group,
      category: group === '寢具' ? 'bedding' : 'ready_meal',
      phone: optional(row['電話']), contact: optional(row['聯絡人']), address: optional(row['營業地址']),
    });
  }
  for (const [name, list] of dupGroups(out, (r) => r.name)) issues.push({ severity: 'check', kind: 'dup_vendor_name', key: list.map((r) => r.legacy_code).join('、'), name, detail: '廠商名稱重複，只會匯入第一筆' });
  return { rows: dedupe(out, (r) => r.name), issues };
}

export function normalizeProducts(rows) {
  const issues = [];
  const out = [];
  let noGroup = 0;
  for (const row of rows) {
    const sku = str(row['品號']);
    let name = str(row['品名']);
    if (!sku || !name) { issues.push({ severity: 'check', kind: 'product_missing', key: sku, name, detail: '缺品號或品名，未匯入' }); continue; }
    if (sku.length > 30) { issues.push({ severity: 'check', kind: 'sku_too_long', key: sku, name, detail: '品號超過 30 字，未匯入' }); continue; }
    if (name.length > 80) { issues.push({ severity: 'check', kind: 'name_too_long', key: sku, name, detail: '品名超過 80 字，已截斷' }); name = cut(name, 80); }
    const group = optional(row['商品分類']);
    if (!group) noGroup += 1;
    const price = Number(row['零售價']);
    out.push({
      sku, name, unit: cut(str(row['單位']), 10), group_name: group,
      category: BEDDING_GROUPS.has(group) ? 'bedding' : READY_MEAL_GROUPS.has(group) ? 'ready_meal' : null,
      list_price_x100: Number.isFinite(price) && price > 0 ? Math.round(price * 100) : null,
    });
  }
  for (const [name, list] of dupGroups(out, (r) => r.name)) issues.push({ severity: 'check', kind: 'dup_product_name', key: list.map((r) => r.sku).join('、'), name, detail: '同一個品名有多個品號，請確認是同一商品還是不同規格' });
  for (const r of out) if (r.list_price_x100 === null) issues.push({ severity: 'info', kind: 'no_list_price', key: r.sku, name: r.name, detail: '零售價是 0 或空白' });
  if (noGroup) issues.push({ severity: 'info', kind: 'no_group', key: '', name: '', detail: `${noGroup} 筆商品沒有分類` });
  for (const [sku, list] of dupGroups(out, (r) => r.sku)) issues.push({ severity: 'check', kind: 'dup_sku', key: sku, name: list[0].name, detail: '品號重複，只會匯入第一筆' });
  return { rows: dedupe(out, (r) => r.sku), issues };
}

export function normalizeCustomers(rows) {
  const issues = [];
  const out = [];
  for (const row of rows) {
    const code = str(row['客戶代號']);
    let name = str(row['客戶簡稱']);
    if (!code || !name) { issues.push({ severity: 'check', kind: 'customer_missing', key: code, name, detail: '缺客戶代號或簡稱，未匯入' }); continue; }
    if (code.length > 30) { issues.push({ severity: 'check', kind: 'code_too_long', key: code, name, detail: '代號超過 30 字，未匯入' }); continue; }
    if (name.length > 60) { issues.push({ severity: 'check', kind: 'name_too_long', key: code, name, detail: '名稱超過 60 字，已截斷' }); name = cut(name, 60); }
    const t = taxId(row['統一編號']);
    if (t.bad) issues.push({ severity: 'check', kind: 'bad_tax_id', key: code, name, detail: `統編格式不正確（${t.raw}），未匯入統編` });
    const type = optional(row['客戶類型']);
    const billTo = optional(row['請款客戶']);
    if (billTo && billTo !== name) issues.push({ severity: 'info', kind: 'bill_to_other', key: code, name, detail: `請款客戶是「${billTo}」（對帳單會歸在請款客戶底下）` });
    out.push({
      code, name, tax_id: t.value, bill_to_name: billTo && billTo !== name ? billTo : null, customer_type: type,
      phone: optional(row['電話']), mobile: optional(row['手機']), contact: optional(row['主聯絡人']), address: optional(row['送貨地址']),
      // 潛在客戶還沒有交易，先設為停用（選單不出現），需要時在設定裡啟用
      active: type === '潛在客戶' ? 0 : 1,
    });
  }
  for (const [name, list] of dupGroups(out, (r) => r.name)) issues.push({ severity: 'check', kind: 'dup_customer_name', key: list.map((r) => r.code).join('、'), name, detail: '同一個客戶名稱有多個代號，請確認是否同一家' });
  for (const [code, list] of dupGroups(out, (r) => r.code)) issues.push({ severity: 'check', kind: 'dup_code', key: code, name: list[0].name, detail: '客戶代號重複，只會匯入第一筆' });
  return { rows: dedupe(out, (r) => r.code), issues };
}

function dedupe(list, keyOf) {
  const seen = new Set();
  return list.filter((r) => { const k = keyOf(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

export const NORMALIZERS = { vendors: normalizeVendors, products: normalizeProducts, customers: normalizeCustomers };

export const ISSUE_LABELS = {
  vendor_no_name: '廠商沒有名稱', name_too_long: '名稱過長', bad_tax_id: '統編格式不正確', no_tax_id: '沒有統編', dup_vendor_name: '廠商名稱重複',
  product_missing: '商品缺品號或品名', sku_too_long: '品號過長', dup_product_name: '品名重複（不同品號）', no_list_price: '零售價是 0', no_group: '商品沒有分類', dup_sku: '品號重複',
  customer_missing: '客戶缺代號或簡稱', code_too_long: '客戶代號過長', bill_to_other: '請款客戶不是自己', dup_customer_name: '客戶名稱重複（不同代號）', dup_code: '客戶代號重複',
};

// 偵測 Excel 是哪一種主檔（看標題列）
export function detectKind(headers) {
  const set = new Set(headers.map((h) => String(h ?? '').trim()));
  if (set.has('品號') && set.has('品名')) return 'products';
  if (set.has('客戶代號') && set.has('客戶簡稱')) return 'customers';
  if (set.has('廠商代號') && set.has('廠商簡稱')) return 'vendors';
  return null;
}

export function rowsToObjects(sheetRows) {
  const [head, ...body] = sheetRows;
  const keys = head.map((h) => String(h ?? '').trim());
  return body.filter((r) => r.some((c) => c !== null && c !== '')).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null])));
}

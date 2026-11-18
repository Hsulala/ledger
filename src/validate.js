// 輸入驗證：進貨單、訂單與主檔。錯誤統一回 400 並指出是哪個欄位。
import { HttpError, isDateText } from './util.js';

const DOC_TYPES = ['quote', 'delivery', 'shipment', 'sales'];
const LINE_TYPES = ['product', 'freight', 'gift'];
const TAX_MODES = ['excl', 'incl', 'unknown'];
const CATEGORIES = ['bedding', 'chicken_feet', 'ready_meal'];

const isInt = (v) => Number.isInteger(v) && Math.abs(v) <= 1_000_000_000;
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

class Fields {
  constructor() { this.errors = {}; }
  bad(name, message) { this.errors[name] = message; }
  done() { if (Object.keys(this.errors).length) throw new HttpError(400, '資料有誤', { fields: this.errors }); }
}

function optInt(f, name, v, { min = 0 } = {}) {
  if (v === undefined || v === null || v === '') return null;
  if (!isInt(v) || v < min) { f.bad(name, `必須是整數${min === 0 ? '且不可為負' : ''}`); return null; }
  return v;
}
function flagsText(f, name, v) {
  if (v === undefined || v === null) return '{}';
  if (typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => x !== true)) { f.bad(name, '格式不正確'); return '{}'; }
  return JSON.stringify(v);
}

// 回傳驗證後的 { header, items }；ids 需要另外用資料庫確認屬於這家店（見 routes）
export function parseDocument(kind, body, { forConfirm = false } = {}) {
  const f = new Fields();
  if (!body || typeof body !== 'object') throw new HttpError(400, '資料格式不正確');
  const header = {};

  if (kind === 'purchase') {
    if (typeof body.vendor_id !== 'string' || !body.vendor_id) f.bad('vendor_id', '請選擇廠商');
    header.vendor_id = body.vendor_id;
    if (!DOC_TYPES.includes(body.doc_type)) f.bad('doc_type', '請選擇單據類型');
    header.doc_type = body.doc_type;
    header.vendor_doc_no = text(body.vendor_doc_no, 40);
    if (body.tax_mode !== undefined && !TAX_MODES.includes(body.tax_mode)) f.bad('tax_mode', '稅別不正確');
    header.tax_mode = body.tax_mode ?? 'unknown';
  } else {
    if (typeof body.customer_id !== 'string' || !body.customer_id) f.bad('customer_id', '請選擇客戶');
    header.customer_id = body.customer_id;
    header.sales_no = text(body.sales_no, 40);
    header.salesperson = text(body.salesperson, 30);
    header.invoice_no = text(body.invoice_no, 20);
  }
  if (body.doc_date === null || body.doc_date === undefined || body.doc_date === '') header.doc_date = null;
  else if (!isDateText(body.doc_date)) f.bad('doc_date', '日期格式必須是 YYYY-MM-DD');
  else header.doc_date = body.doc_date;
  if (forConfirm && !header.doc_date) f.bad('doc_date', '確認入帳前請填寫單據日期');
  header.doc_date_raw = text(body.doc_date_raw, 30);
  header.tax_amount = optInt(f, 'tax_amount', body.tax_amount);
  header.note = text(body.note, 500);
  header.flags = flagsText(f, 'flags', body.flags);
  header.source = 'web';

  const rawItems = body.items ?? [];
  if (!Array.isArray(rawItems) || rawItems.length > 200) { f.bad('items', '品項最多 200 行'); }
  const items = [];
  (Array.isArray(rawItems) ? rawItems : []).forEach((it, i) => {
    const p = `items.${i}`;
    if (!it || typeof it !== 'object') { f.bad(p, '格式不正確'); return; }
    if (it.line_type !== undefined && !LINE_TYPES.includes(it.line_type)) f.bad(`${p}.line_type`, '行類型不正確');
    const row = {
      line_type: it.line_type ?? 'product',
      raw_name: text(it.raw_name, 80),
      product_id: typeof it.product_id === 'string' && it.product_id ? it.product_id : null,
      unit: text(it.unit, 10),
      unit_price_x100: optInt(f, `${p}.unit_price_x100`, it.unit_price_x100),
      amount: optInt(f, `${p}.amount`, it.amount, { min: -1_000_000_000 }),
      note: text(it.note, 200),
      flags: flagsText(f, `${p}.flags`, it.flags),
      edited: it.edited ? 1 : 0,
      confidence: typeof it.confidence === 'number' && it.confidence >= 0 && it.confidence <= 1 ? it.confidence : null,
    };
    if (kind === 'purchase') {
      row.vendor_sku = text(it.vendor_sku, 40);
      row.cases = optInt(f, `${p}.cases`, it.cases);
      row.packs = optInt(f, `${p}.packs`, it.packs);
    } else row.qty = optInt(f, `${p}.qty`, it.qty);
    if (row.line_type === 'product' && !row.raw_name && !row.product_id) f.bad(`${p}.raw_name`, '請填寫品名');
    items.push(row);
  });
  if (forConfirm && !items.length) f.bad('items', '確認入帳前至少要有一行品項');

  f.done();
  // 單據合計由程式加總（AI 不計算金額）：金額留空的行不計
  header.total_amount = items.reduce((sum, it) => sum + (it.amount ?? 0), 0);
  return { header, items };
}

const unique = (list) => [...new Set(list.filter(Boolean))];

// 確認引用的主檔都屬於這家店（scope 已帶 store_id）
export async function checkReferences(kind, scope, header, items) {
  const f = new Fields();
  if (kind === 'purchase') {
    if (!(await scope.get('vendors', header.vendor_id))) f.bad('vendor_id', '找不到這家廠商');
  } else if (!(await scope.get('customers', header.customer_id))) f.bad('customer_id', '找不到這個客戶');
  const productIds = unique(items.map((i) => i.product_id));
  if (productIds.length) {
    const found = await scope.list('products', { in: { id: productIds }, limit: 500 });
    const known = new Set(found.map((p) => p.id));
    items.forEach((it, i) => { if (it.product_id && !known.has(it.product_id)) f.bad(`items.${i}.product_id`, '找不到這個商品'); });
  }
  f.done();
}

export function parseFileIds(body) {
  const ids = body?.file_ids ?? [];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'file_ids 格式不正確');
  return unique(ids);
}

const MASTER = {
  vendors: { table: 'vendors', fields: { name: ['str', 60, true], category: ['enum', CATEGORIES, true], active: ['bool'] }, searchOrder: [['name', 'asc']] },
  products: { table: 'products', fields: { sku: ['str', 30], name: ['str', 80, true], category: ['enum', CATEGORIES], unit: ['str', 10], pack_per_case: ['posint'], active: ['bool'] }, searchOrder: [['name', 'asc']] },
  customers: { table: 'customers', fields: { code: ['str', 30], name: ['str', 60, true], active: ['bool'] }, searchOrder: [['name', 'asc']] },
  companies: { table: 'companies', fields: { name: ['str', 60, true], tax_id: ['taxid'], aliases: ['strlist'], active: ['bool'] }, searchOrder: [['name', 'asc']] },
  aliases: { table: 'vendor_item_aliases', fields: { vendor_id: ['id', true], raw_name: ['str', 80, true], vendor_sku: ['str', 40], product_id: ['id', true] }, searchOrder: [['raw_name', 'asc']] },
};
export const MASTER_KINDS = MASTER;

export function parseMaster(kind, body, { partial }) {
  const cfg = MASTER[kind];
  const f = new Fields();
  const out = {};
  for (const [name, [type, arg, required]] of Object.entries(cfg.fields)) {
    const v = body?.[name];
    const requiredFlag = type === 'str' ? required : type === 'enum' ? required : type === 'id' ? arg : false;
    if (v === undefined) { if (!partial && requiredFlag) f.bad(name, '必填'); continue; }
    if (type === 'str') {
      const s = text(v, arg);
      if (!s && requiredFlag) f.bad(name, '必填'); else out[name] = s === '' && !requiredFlag ? null : s;
    } else if (type === 'enum') {
      if (v === null && !requiredFlag) out[name] = null; else if (!arg.includes(v)) f.bad(name, '選項不正確'); else out[name] = v;
    } else if (type === 'bool') out[name] = v ? 1 : 0;
    else if (type === 'posint') { if (v === null || v === '') out[name] = null; else if (!Number.isInteger(v) || v < 1) f.bad(name, '必須是正整數'); else out[name] = v; }
    else if (type === 'taxid') { if (!v) out[name] = null; else if (!/^\d{8}$/.test(String(v))) f.bad(name, '統編必須是 8 位數字'); else out[name] = String(v); }
    else if (type === 'strlist') { if (!Array.isArray(v) || v.length > 10 || v.some((x) => typeof x !== 'string')) f.bad(name, '格式不正確'); else out[name] = JSON.stringify(v.map((x) => x.trim()).filter(Boolean)); }
    else if (type === 'id') { if (typeof v !== 'string' || !v) f.bad(name, '必填'); else out[name] = v; }
  }
  f.done();
  return out;
}

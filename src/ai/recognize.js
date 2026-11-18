// 單據判讀流程：檢查本月上限 → 呼叫模型讀取 → 存下原始輸出 → 程式端換算、比對並建立草稿。
// 草稿一律要人確認；這裡不會把任何單據直接入帳，也不會自己建立廠商或商品。

import { HttpError, nowIso, uuid } from '../util.js';
import { createDocument } from '../db/documents.js';
import { countRecognitions, recordExtraction } from '../db/ai.js';
import { callModel, MAX_IMAGE_BYTES, PROMPT_VERSION } from './extract.js';
import { matchParty, matchProduct, parseDateText, toInt, toPriceX100 } from './normalize.js';

export const DEFAULT_MONTHLY_LIMIT = 300; // 每家店每月判讀份數（一份可含多頁）；可在後台調整
export const SETTING_LIMIT = 'ai_monthly_limit';

const monthStart = (now = new Date()) => `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;

export async function usageOf(db, storeId, now = new Date()) {
  const raw = await db.system.getSetting(storeId, SETTING_LIMIT);
  const limit = raw === null ? DEFAULT_MONTHLY_LIMIT : Number(raw);
  return { used: await countRecognitions(db.scope(storeId), monthStart(now)), limit };
}

const TITLE_TYPES = [[/出貨/, 'shipment'], [/送貨/, 'delivery'], [/進貨/, 'delivery'], [/報價/, 'quote'], [/銷貨|銷售/, 'sales']];
const docTypeOf = (title) => { for (const [re, t] of TITLE_TYPES) if (re.test(title ?? '')) return { type: t, uncertain: false }; return { type: 'delivery', uncertain: true }; };
const ITEM_FLAG = { name: 'raw_name', sku: 'vendor_sku', cases: 'cases', packs: 'packs', unit: 'unit', unit_price: 'unit_price_x100', amount: 'amount' };

export async function recognize({ env, db, scope, store, userId, fileIds, fetchImpl, now = new Date() }) {
  if (!fileIds.length) throw new HttpError(400, '請選擇要判讀的檔案');
  const files = await scope.list('source_files', { in: { id: fileIds } });
  if (files.length !== fileIds.length) throw new HttpError(404, '找不到部分檔案');
  if (files.some((f) => f.doc_id || f.status !== 'pending')) throw new HttpError(409, '部分檔案已經建立過單據');
  const { used, limit } = await usageOf(db, store.id, now);
  if (used >= limit) throw new HttpError(429, `本月 AI 判讀次數已達上限（${limit} 份）。如需調整，請聯絡管理者。`);

  const ordered = fileIds.map((id) => files.find((f) => f.id === id));
  const loaded = [];
  for (const f of ordered) {
    const object = await env.FILES.get(f.r2_key);
    if (!object) throw new HttpError(404, '找不到檔案內容');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (f.mime !== 'application/pdf' && bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, `圖片「${f.original_name}」超過 5 MB，請縮小後再上傳`);
    loaded.push({ mime: f.mime, bytes });
  }

  const { output, model, usage } = await callModel({ env, fetchImpl, files: loaded });
  const extractionId = uuid();
  await recordExtraction(db.scope(store.id), {
    usage: { id: uuid(), model, purpose: 'recognize', input_tokens: usage.input, output_tokens: usage.output, cost_usd_micros: 0, at: nowIso() },
    extraction: {
      id: extractionId, file_id: fileIds[0], file_ids: JSON.stringify(fileIds), company_id: scope.companyId, model, prompt_version: PROMPT_VERSION,
      raw_output: JSON.stringify(output), field_confidence: JSON.stringify({ uncertain_fields: output.uncertain_fields ?? [] }), status: 'extracted', created_at: nowIso(),
    },
  });
  const built = await buildFromExtraction({ scope, db, store, userId, extractionId, output, fileIds, now });
  return { extraction_id: extractionId, ...built, usage: { used: used + 1, limit } };
}

// 用已存下的判讀結果重新比對、建立草稿（廠商或客戶補建後使用，不會再呼叫 AI、不會再計次）
export async function rebuild({ scope, db, store, userId, extractionId, now = new Date() }) {
  const ex = await db.scope(store.id).get('extractions', extractionId);
  if (!ex || ex.company_id !== scope.companyId) throw new HttpError(404, '找不到這筆判讀結果');
  if (ex.status === 'built') throw new HttpError(409, '這筆判讀結果已經建立過草稿');
  return { extraction_id: extractionId, ...(await buildFromExtraction({ scope, db, store, userId, extractionId, output: JSON.parse(ex.raw_output), fileIds: JSON.parse(ex.file_ids), now })) };
}

async function buildFromExtraction({ scope, db, store, userId, extractionId, output, fileIds, now }) {
  const sys = db.scope(store.id);
  const setStatus = (status, extra = {}) => sys.update('extractions', extractionId, { status, ...extra });
  const kind = output.doc_kind === 'purchase_delivery' ? 'purchase' : output.doc_kind === 'sales_order' ? 'order' : null;
  if (!kind) {
    await setStatus('unsupported', { doc_kind: output.doc_kind });
    const label = { vendor_statement: '對帳單', payment_request: '請款單' }[output.doc_kind] ?? '這類單據';
    return { status: 'unsupported', doc_kind: output.doc_kind, message: `這是${label}，目前還不能自動處理（月底對帳功能完成後才會支援）。已保留判讀結果。` };
  }

  const warnings = [];
  const [vendors, customers, products, aliases, companies] = await Promise.all([
    scope.list('vendors', { limit: 1000 }), scope.list('customers', { limit: 1000 }),
    scope.list('products', { limit: 5000 }), scope.list('vendor_item_aliases', { limit: 5000 }),
    sys.list('companies', { limit: 100 }),
  ]);

  const header = { source: 'photo' };
  const flags = {};
  let partyId;
  if (kind === 'purchase') {
    const vendor = matchParty(vendors, { name: output.vendor_name, taxId: output.vendor_tax_id });
    if (!vendor) { await setStatus('need_master', { doc_kind: output.doc_kind }); return { status: 'need_vendor', name: output.vendor_name ?? '', tax_id: output.vendor_tax_id ?? '', message: `找不到對應的廠商「${output.vendor_name ?? '未讀到名稱'}」。請先到「設定」建立廠商（填上統編或單上的名稱寫法最好），再按「重新比對」。` }; }
    partyId = vendor.id;
    header.vendor_id = vendor.id;
    const buyer = matchParty(companies, { name: output.buyer_name, taxId: output.buyer_tax_id });
    if (buyer && buyer.id !== scope.companyId) warnings.push(`單上的買方是「${buyer.name}」，和目前選的買方公司不同，請確認選對公司`);
    if (!buyer && (output.buyer_name || output.buyer_tax_id)) warnings.push(`單上的買方「${output.buyer_name ?? output.buyer_tax_id}」找不到對應的買方公司`);
    const t = docTypeOf(output.doc_title);
    header.doc_type = t.type; if (t.uncertain) flags.doc_type = true;
    header.vendor_doc_no = String(output.doc_no ?? '').slice(0, 40);
    if (!header.vendor_doc_no || (output.uncertain_fields ?? []).includes('doc_no')) flags.vendor_doc_no = true;
    header.tax_mode = output.tax_mode === 'excl' || output.tax_mode === 'incl' ? output.tax_mode : 'unknown';
    if (output.tax_mode === 'exempt') warnings.push('單上標示免稅');
  } else {
    const customer = matchParty(customers, { name: output.buyer_name });
    if (!customer) { await setStatus('need_master', { doc_kind: output.doc_kind }); return { status: 'need_customer', name: output.buyer_name ?? '', message: `找不到對應的客戶「${output.buyer_name ?? '未讀到名稱'}」。請先到「設定」建立客戶，再按「重新比對」。` }; }
    partyId = customer.id;
    header.customer_id = customer.id;
    header.sales_no = String(output.doc_no ?? '').slice(0, 40);
    if (!header.sales_no || (output.uncertain_fields ?? []).includes('doc_no')) flags.sales_no = true;
  }

  const date = parseDateText(output.date_text, now);
  header.doc_date = date.date;
  header.doc_date_raw = String(output.date_text ?? '').slice(0, 30);
  if (date.uncertain || (output.uncertain_fields ?? []).includes('date_text')) flags.doc_date = true;
  const tax = toInt(output.printed_tax);
  header.tax_amount = tax.value;

  const items = [];
  for (const it of (output.items ?? []).slice(0, 200)) {
    const itemFlags = {};
    for (const name of it.uncertain_fields ?? []) {
      const key = name === 'qty' ? (kind === 'purchase' ? 'packs' : 'qty') : ITEM_FLAG[name];
      if (key) itemFlags[key] = true;
    }
    const price = toPriceX100(it.unit_price), amount = toInt(it.amount);
    if (price.uncertain) itemFlags.unit_price_x100 = true;
    if (amount.uncertain) itemFlags.amount = true;
    const row = {
      line_type: ['product', 'freight', 'gift'].includes(it.line_type) ? it.line_type : 'product',
      raw_name: String(it.name ?? '').slice(0, 80), unit: String(it.unit ?? '').slice(0, 10),
      unit_price_x100: price.value, amount: amount.value, edited: 0,
    };
    if (kind === 'purchase') {
      row.vendor_sku = String(it.sku ?? '').slice(0, 40);
      const cases = toInt(it.cases), packs = toInt(it.packs ?? it.qty);
      row.cases = cases.value; row.packs = packs.value;
      if (cases.uncertain) itemFlags.cases = true;
      if (packs.uncertain) itemFlags.packs = true;
    } else {
      const qty = toInt(it.qty);
      row.qty = qty.value;
      if (qty.uncertain) itemFlags.qty = true;
      // 訂單的數量乘單價可以直接核對；對不上就標黃，由人看照片決定
      if (qty.value !== null && price.value !== null && amount.value !== null && Math.abs((qty.value * price.value) / 100 - amount.value) > 1) { itemFlags.amount = true; itemFlags.unit_price_x100 = true; }
    }
    if (row.line_type === 'product') {
      row.product_id = matchProduct({ name: row.raw_name }, { vendorId: partyId, aliases, products });
      if (!row.product_id) itemFlags.product_id = true;
    }
    if (!row.raw_name) itemFlags.raw_name = true;
    row.flags = JSON.stringify(itemFlags);
    items.push(row);
  }
  if (!items.length) warnings.push('沒有讀到任何品項，請對照照片手動輸入');

  // 合計由程式加總；單上印的合計只用來對照，不一致就提醒
  const sum = items.reduce((total, it) => total + (it.amount ?? 0), 0);
  header.total_amount = sum;
  const printed = toInt(output.printed_total);
  if (printed.value !== null && printed.value !== sum && printed.value !== sum + (tax.value ?? 0)) warnings.push(`單上合計 ${printed.value} 與品項加總 ${sum} 不一致，請對照照片`);
  if (items.some((it) => it.amount === null)) warnings.push('有品項沒有金額（可能被遮住或單上沒印）');
  if ((output.handwritten_notes ?? []).length) warnings.push('照片上有手寫字，只供參考，沒有帶入資料');
  if (output.notes) warnings.push(String(output.notes).slice(0, 200));
  header.note = warnings.length ? `【判讀提醒】${warnings.join('；')}`.slice(0, 500) : '';
  header.flags = JSON.stringify(flags);

  const id = await createDocument(scope, kind, { header, items, fileIds }, userId);
  await setStatus('built', { doc_kind: kind, doc_id: id });
  return { status: 'draft', kind, id, warnings, flagged: Object.keys(flags).length + items.filter((it) => it.flags !== '{}').length };
}

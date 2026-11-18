// 進貨單與訂單的寫入、查詢。所有多句寫入都用 batch（一起成功或一起失敗），
// 「只有草稿可以改」「只有草稿可以確認」的條件寫進 SQL 本身，不依賴先讀後寫。

import { uuid, nowIso } from '../util.js';

export const KINDS = {
  purchase: {
    table: 'purchases', itemTable: 'purchase_items', fk: 'purchase_id', audit: 'purchase',
    headerCols: ['vendor_id', 'doc_type', 'vendor_doc_no', 'doc_date', 'doc_date_raw', 'tax_mode', 'tax_amount', 'total_amount', 'source', 'flags', 'note'],
    itemCols: ['line_type', 'raw_name', 'vendor_sku', 'product_id', 'cases', 'packs', 'unit', 'unit_price_x100', 'amount', 'confidence', 'edited', 'flags', 'note'],
    searchCols: ['vendor_doc_no', 'note'], itemSearchCols: ['raw_name', 'vendor_sku'],
  },
  order: {
    table: 'orders', itemTable: 'order_items', fk: 'order_id', audit: 'order',
    headerCols: ['customer_id', 'sales_no', 'doc_date', 'doc_date_raw', 'salesperson', 'tax_amount', 'total_amount', 'invoice_no', 'source', 'flags', 'note'],
    itemCols: ['line_type', 'raw_name', 'product_id', 'qty', 'unit', 'unit_price_x100', 'amount', 'confidence', 'edited', 'flags', 'note'],
    searchCols: ['sales_no', 'invoice_no', 'salesperson', 'note'], itemSearchCols: ['raw_name'],
  },
};

const stamp = () => nowIso();
const auditStmt = (s, kind, action, id, userId, detail, guardSql = '', guardParams = []) =>
  s.prepare(
    `INSERT INTO audit_log (id, store_id, user_id, actor_kind, action, entity, entity_id, detail, at)
     SELECT ?, :store, ?, 'user', ?, ?, ?, ?, ? ${guardSql ? `WHERE ${guardSql}` : ''}`,
    [uuid(), userId, action, KINDS[kind].audit, id, JSON.stringify(detail), stamp(), ...guardParams]);

// 「這張單還是草稿」的條件，可嵌在任何 INSERT ... SELECT ... WHERE 或 DELETE ... WHERE
const draftGuard = (cfg) => `EXISTS (SELECT 1 FROM ${cfg.table} WHERE store_id = :store AND company_id = ? AND id = ? AND status = 'draft')`;

function itemInsert(s, cfg, docId, position, item) {
  const cols = ['id', 'store_id', cfg.fk, 'position', ...cfg.itemCols];
  const values = [uuid(), docId, position, ...cfg.itemCols.map((c) => item[c] ?? defaultFor(c))];
  return s.prepare(
    `INSERT INTO ${cfg.itemTable} (${cols.join(', ')}) SELECT ?, :store, ${[...cols.slice(2)].map(() => '?').join(', ')} WHERE ${draftGuard(cfg)}`,
    [values[0], ...values.slice(1), s.companyId, docId]);
}
function defaultFor(col) {
  if (col === 'edited') return 0;
  if (col === 'flags') return '{}';
  if (['raw_name', 'vendor_sku', 'unit', 'note'].includes(col)) return '';
  if (col === 'line_type') return 'product';
  return null;
}

function fileAttachStmts(s, cfg, kind, docId, fileIds) {
  const guard = draftGuard(cfg);
  const stmts = [
    // 這張單原本掛的檔案，不在新名單內的放回待處理
    s.prepare(
      `UPDATE source_files SET doc_kind = NULL, doc_id = NULL WHERE store_id = :store AND doc_kind = ? AND doc_id = ?
       ${fileIds.length ? `AND id NOT IN (${fileIds.map(() => '?').join(',')})` : ''} AND ${guard}`,
      [kind, docId, ...fileIds, s.companyId, docId]),
  ];
  fileIds.forEach((fid, index) => stmts.push(s.prepare(
    `UPDATE source_files SET doc_kind = ?, doc_id = ?, page_no = ? WHERE store_id = :store AND id = ? AND company_id = ?
     AND (doc_id IS NULL OR doc_id = ?) AND ${guard}`,
    [kind, docId, index + 1, fid, s.companyId, docId, s.companyId, docId])));
  return stmts;
}

const pick = (obj, cols) => Object.fromEntries(cols.filter((c) => obj[c] !== undefined).map((c) => [c, obj[c]]));

export async function createDocument(s, kind, { header, items, fileIds }, userId) {
  const cfg = KINDS[kind];
  const id = uuid(), t = stamp();
  const insert = s.insertStmt(cfg.table, {
    id, ...pick(header, cfg.headerCols), status: 'draft', created_by: userId, created_at: t, updated_at: t,
  });
  const stmts = [insert.stmt];
  items.forEach((item, i) => stmts.push(itemInsert(s, cfg, id, i + 1, item)));
  stmts.push(...fileAttachStmts(s, cfg, kind, id, fileIds));
  stmts.push(auditStmt(s, kind, `${cfg.audit}.create`, id, userId, { items: items.length, total_amount: header.total_amount ?? null }));
  await s.batch(stmts);
  return id;
}

// 回傳 false 代表單據不是草稿（已確認或不存在），什麼都沒有寫入
export async function updateDocument(s, kind, id, { header, items, fileIds }, userId) {
  const cfg = KINDS[kind];
  const t = stamp();
  const cols = cfg.headerCols.filter((c) => header[c] !== undefined);
  const guard = draftGuard(cfg);
  const stmts = [
    s.prepare(
      `UPDATE ${cfg.table} SET ${[...cols.map((c) => `${c} = ?`), 'updated_at = ?'].join(', ')}
       WHERE store_id = :store AND company_id = ? AND id = ? AND status = 'draft'`,
      [...cols.map((c) => header[c]), t, s.companyId, id]),
    s.prepare(`DELETE FROM ${cfg.itemTable} WHERE store_id = :store AND ${cfg.fk} = ? AND ${guard}`, [id, s.companyId, id]),
  ];
  items.forEach((item, i) => stmts.push(itemInsert(s, cfg, id, i + 1, item)));
  stmts.push(...fileAttachStmts(s, cfg, kind, id, fileIds));
  stmts.push(auditStmt(s, kind, `${cfg.audit}.update`, id, userId, { items: items.length, total_amount: header.total_amount ?? null },
    `EXISTS (SELECT 1 FROM ${cfg.table} WHERE store_id = :store AND company_id = ? AND id = ? AND status = 'draft' AND updated_at = ?)`, [s.companyId, id, t]));
  const res = await s.batch(stmts);
  return Number(res[0].meta.changes) === 1;
}

// 確認入帳：單據狀態、檔案狀態、稽核紀錄在同一個交易；已確認的單據再確認不會有任何變動
export async function confirmDocument(s, kind, id, userId) {
  const cfg = KINDS[kind];
  const t = stamp();
  const confirmedGuard = `EXISTS (SELECT 1 FROM ${cfg.table} WHERE store_id = :store AND company_id = ? AND id = ? AND status = 'confirmed' AND confirmed_at = ?)`;
  const res = await s.batch([
    s.prepare(
      `UPDATE ${cfg.table} SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ?
       WHERE store_id = :store AND company_id = ? AND id = ? AND status = 'draft'`, [userId, t, t, s.companyId, id]),
    s.prepare(
      `UPDATE source_files SET status = 'attached' WHERE store_id = :store AND doc_kind = ? AND doc_id = ? AND ${confirmedGuard}`,
      [kind, id, s.companyId, id, t]),
    auditStmt(s, kind, `${cfg.audit}.confirm`, id, userId, {}, confirmedGuard, [s.companyId, id, t]),
  ]);
  return Number(res[0].meta.changes) === 1;
}

export async function getDocument(s, kind, id) {
  const cfg = KINDS[kind];
  const header = await s.get(cfg.table, id);
  if (!header) return null;
  const items = await s.list(cfg.itemTable, { where: { [cfg.fk]: id }, order: [['position', 'asc']], limit: 500 });
  const files = await s.list('source_files', { where: { doc_kind: kind, doc_id: id }, order: [['page_no', 'asc']], limit: 100 });
  return { ...header, items, files };
}

export async function listDocuments(s, kind, { status, vendorId, customerId, from, to, q, limit = 50, offset = 0 } = {}) {
  const cfg = KINDS[kind];
  const where = { status, vendor_id: kind === 'purchase' ? vendorId : undefined, customer_id: kind === 'order' ? customerId : undefined };
  const base = { where, range: { col: 'doc_date', from, to } };
  const order = [['doc_date', 'desc'], ['created_at', 'desc']];
  if (!q) {
    return { rows: await s.list(cfg.table, { ...base, order, limit, offset }), total: await s.count(cfg.table, base) };
  }
  // 關鍵字：單號與備註，或品項名稱符合的單據
  const itemHits = await s.list(cfg.itemTable, { search: { cols: cfg.itemSearchCols, text: q }, limit: 500 });
  const ids = [...new Set(itemHits.map((r) => r[cfg.fk]))];
  const byHeader = await s.list(cfg.table, { ...base, search: { cols: cfg.searchCols, text: q }, order, limit: 500 });
  const byItems = ids.length ? await s.list(cfg.table, { ...base, in: { id: ids }, order, limit: 500 }) : [];
  const merged = [...new Map([...byHeader, ...byItems].map((r) => [r.id, r])).values()]
    .sort((a, b) => String(b.doc_date ?? '').localeCompare(String(a.doc_date ?? '')));
  return { rows: merged.slice(offset, offset + limit), total: merged.length };
}

// 單號重複：進貨單看「廠商＋廠商單號」，訂單看「銷貨單號」。不分公司（廠商與銷貨單號本身就不該重複）。
export async function findDuplicates(s, kind, header, excludeId) {
  const wide = s.allCompanies();
  if (kind === 'purchase') {
    if (!header.vendor_doc_no) return [];
    const rows = await wide.list('purchases', { where: { vendor_id: header.vendor_id, vendor_doc_no: header.vendor_doc_no, status: 'confirmed' }, limit: 20 });
    return rows.filter((r) => r.id !== excludeId).map(({ id, company_id, doc_date, total_amount }) => ({ id, company_id, doc_date, total_amount }));
  }
  if (!header.sales_no) return [];
  const rows = await wide.list('orders', { where: { sales_no: header.sales_no, status: 'confirmed' }, limit: 20 });
  return rows.filter((r) => r.id !== excludeId).map(({ id, company_id, doc_date, total_amount }) => ({ id, company_id, doc_date, total_amount }));
}

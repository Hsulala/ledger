// 店家強制條件層：所有「有店家的資料表」只能從這裡讀寫，查詢一律自動帶 store_id（兩家買方公司的表再帶 company_id）。
// 其他程式碼不得直接使用 D1（test/isolation.test.js 會掃描原始碼檢查）。
//
// 寫入一律回傳 prepared statement，讓呼叫端能用 batch 做成「一起成功或一起失敗」。

import { uuid } from '../util.js';

// 值 'co' 表示該表有 company_id；0 表示只有 store_id
const TABLES = {
  companies: 0, vendors: 0, vendor_formats: 0, products: 0, vendor_item_aliases: 0, vendor_prices: 0, customers: 0,
  source_files: 'co', extractions: 0,
  purchases: 'co', purchase_items: 0, orders: 'co', order_items: 0,
  returns: 'co', daily_notes: 'co', vendor_payments: 'co', vendor_statements: 'co', statement_lines: 0, statement_diffs: 0,
  customer_payments: 'co', customer_statements: 'co', customer_openings: 'co',
  audit_log: 0, store_users: 0, ai_usage: 0,
};
const NO_ID = new Set(['vendor_formats']);
const COL = /^[a-z][a-z0-9_]*$/;
const FORBIDDEN_PATCH = new Set(['id', 'store_id', 'company_id']);
const escapeLike = (text) => String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);

export function createScope(d1, { storeId, companyId = null }) {
  if (typeof storeId !== 'string' || !storeId) throw new Error('缺少 storeId');
  const known = (t) => { if (!(t in TABLES)) throw new Error(`未知的資料表：${t}`); return t; };
  const col = (c) => { if (!COL.test(c)) throw new Error(`不合法的欄位：${c}`); return c; };
  const hasCompany = (t) => TABLES[t] === 'co';
  const prep = (sql, params) => d1.prepare(sql).bind(...params.map((v) => (v === undefined ? null : v)));

  function filter(t, opts = {}) {
    const parts = ['store_id = ?'];
    const params = [storeId];
    if (hasCompany(t) && companyId) { parts.push('company_id = ?'); params.push(companyId); }
    for (const [c, v] of Object.entries(opts.where ?? {})) {
      if (v === undefined) continue;
      if (v === null) parts.push(`${col(c)} IS NULL`);
      else { parts.push(`${col(c)} = ?`); params.push(v); }
    }
    for (const [c, list] of Object.entries(opts.in ?? {})) {
      if (!list.length) { parts.push('0'); continue; }
      parts.push(`${col(c)} IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (opts.range) {
      const { col: c, from, to } = opts.range;
      if (from) { parts.push(`${col(c)} >= ?`); params.push(from); }
      if (to) { parts.push(`${col(c)} <= ?`); params.push(to); }
    }
    if (opts.search?.text) {
      const like = `%${escapeLike(opts.search.text)}%`;
      parts.push(`(${opts.search.cols.map((c) => `${col(c)} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      params.push(...opts.search.cols.map(() => like));
    }
    return { sql: parts.join(' AND '), params };
  }

  function orderSql(order) {
    // 預設用 id 排序（每張表都有 id、順序固定）；要看最新的就明確指定 created_at
    if (!order) return 'ORDER BY id ASC';
    return `ORDER BY ${order.map(([c, dir]) => `${col(c)} ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`;
  }

  const scope = {
    storeId,
    companyId,

    // 同一家店、不限公司（只用在跨公司的提醒，例如單號重複）
    allCompanies: () => createScope(d1, { storeId }),
    // 同一家店、指定公司
    forCompany: (id) => createScope(d1, { storeId, companyId: id }),

    async list(t, opts = {}) {
      known(t);
      const { sql, params } = filter(t, opts);
      const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
      const offset = Math.max(Number(opts.offset) || 0, 0);
      const { results } = await prep(`SELECT * FROM ${t} WHERE ${sql} ${orderSql(opts.order)} LIMIT ${limit} OFFSET ${offset}`, params).all();
      return results;
    },
    async count(t, opts = {}) {
      known(t);
      const { sql, params } = filter(t, opts);
      const row = await prep(`SELECT COUNT(*) AS n FROM ${t} WHERE ${sql}`, params).first();
      return Number(row?.n ?? 0);
    },
    async get(t, id, idCol = 'id') {
      known(t);
      const { sql, params } = filter(t, { where: { [col(idCol)]: id } });
      return (await prep(`SELECT * FROM ${t} WHERE ${sql}`, params).first()) ?? null;
    },

    insertStmt(t, row) {
      known(t);
      const data = { ...row, store_id: storeId };
      if (hasCompany(t)) {
        if (!companyId) throw new Error(`${t} 需要指定買方公司`);
        data.company_id = companyId;
      }
      if (!NO_ID.has(t) && !data.id) data.id = uuid();
      const keys = Object.keys(data).filter((k) => data[k] !== undefined);
      const values = keys.map((k) => (data[k] !== null && typeof data[k] === 'object' ? JSON.stringify(data[k]) : data[k]));
      return { stmt: prep(`INSERT INTO ${t} (${keys.map(col).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, values), id: data.id };
    },
    updateStmt(t, id, patch, idCol = 'id') {
      known(t);
      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
      for (const k of keys) if (FORBIDDEN_PATCH.has(k)) throw new Error(`不可更新欄位：${k}`);
      if (!keys.length) throw new Error('沒有要更新的欄位');
      const values = keys.map((k) => (patch[k] !== null && typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k]));
      const { sql, params } = filter(t, { where: { [col(idCol)]: id } });
      return prep(`UPDATE ${t} SET ${keys.map((k) => `${col(k)} = ?`).join(', ')} WHERE ${sql}`, [...values, ...params]);
    },
    deleteStmt(t, id) {
      known(t);
      const { sql, params } = filter(t, { where: { id } });
      return prep(`DELETE FROM ${t} WHERE ${sql}`, params);
    },

    async create(t, row) {
      const { stmt, id } = scope.insertStmt(t, row);
      await stmt.run();
      return id;
    },
    async update(t, id, patch, idCol = 'id') {
      const res = await scope.updateStmt(t, id, patch, idCol).run();
      return Number(res.meta?.changes ?? 0);
    },

    // 自訂 SQL：範本一定要含 :store，會替換成店家參數（不能漏）。其餘用 ?，依出現順序帶入 params。
    prepare(template, params = []) {
      if (!template.includes(':store')) throw new Error('自訂 SQL 必須使用 :store 條件');
      const values = [];
      let next = 0;
      const sql = template.replace(/:store|\?/g, (token) => {
        if (token === ':store') { values.push(storeId); return '?'; }
        if (next >= params.length) throw new Error('參數數量不足');
        values.push(params[next]); next += 1; return '?';
      });
      if (next !== params.length) throw new Error('參數數量過多');
      return prep(sql, values);
    },

    batch: (stmts) => d1.batch(stmts),
  };
  return scope;
}

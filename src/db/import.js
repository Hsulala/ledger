// 主檔匯入的資料庫操作。自訂 SQL 只能放在 src/db。
// 規則：只新增沒有的資料；已存在的（同代號／品號／名稱）一律略過，不覆蓋，避免蓋掉後來在系統裡改過的內容。
const TABLE_KEY = { vendors: ['legacy_code', 'name'], products: ['sku'], customers: ['code'] };
const CHUNK = 100;

export async function existingKeys(s, kind) {
  const keys = TABLE_KEY[kind];
  const { results } = await s.prepare(`SELECT ${keys.join(', ')} FROM ${kind} WHERE store_id = :store`, []).all();
  const sets = Object.fromEntries(keys.map((k) => [k, new Set()]));
  for (const row of results) for (const k of keys) if (row[k]) sets[k].add(row[k]);
  return sets;
}

function isExisting(kind, row, sets) {
  if (kind === 'vendors') return (row.legacy_code && sets.legacy_code.has(row.legacy_code)) || sets.name.has(row.name);
  if (kind === 'products') return sets.sku.has(row.sku);
  return sets.code.has(row.code);
}

// 回傳 { fresh, existing }：哪些會新增、哪些因已存在而略過
export async function splitByExisting(s, kind, rows) {
  const sets = await existingKeys(s, kind);
  const fresh = [], existing = [];
  for (const r of rows) (isExisting(kind, r, sets) ? existing : fresh).push(r);
  return { fresh, existing };
}

export async function insertMaster(s, kind, rows) {
  const at = new Date().toISOString();
  for (let i = 0; i < rows.length; i += CHUNK) {
    await s.batch(rows.slice(i, i + CHUNK).map((r) => s.insertStmt(kind, { ...r, created_at: at }).stmt));
  }
  return rows.length;
}

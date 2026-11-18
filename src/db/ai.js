// AI 用量查詢（本月已判讀份數）。自訂 SQL 只能放在 src/db。
export async function countRecognitions(s, since) {
  const row = await s.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE store_id = :store AND at >= ? AND purpose = ?', [since, 'recognize']).first();
  return Number(row?.n ?? 0);
}

// 判讀結果與用量一起寫入（一起成功或一起失敗）
export async function recordExtraction(s, { extraction, usage }) {
  await s.batch([s.insertStmt('ai_usage', usage).stmt, s.insertStmt('extractions', extraction).stmt]);
}

// 確認入帳後，把人工確認過的「單上寫法 → 商品」記下來，下次相同寫法自動對應
export async function learnAliases(s, vendorId, items) {
  const t = new Date().toISOString();
  const seen = new Set();
  const stmts = [];
  for (const it of items) {
    const raw = String(it.raw_name ?? '').trim();
    if (it.line_type !== 'product' || !it.product_id || !raw || seen.has(raw)) continue;
    seen.add(raw);
    stmts.push(s.prepare(
      `INSERT INTO vendor_item_aliases (id, store_id, vendor_id, raw_name, vendor_sku, product_id, created_at) VALUES (?, :store, ?, ?, ?, ?, ?)
       ON CONFLICT (store_id, vendor_id, raw_name) DO UPDATE SET product_id = excluded.product_id`,
      [crypto.randomUUID(), vendorId, raw, it.vendor_sku || null, it.product_id, t]));
  }
  if (stmts.length) await s.batch(stmts);
}

// 總覽用的彙總查詢（跨買方公司，仍限定在這家店）。只讀，只統計已確認入帳的單據；草稿另外計數。
const rows = async (stmt) => (await stmt.all()).results ?? [];

export async function overview(s, month) {
  const perCompany = (table) => rows(s.prepare(
    `SELECT company_id,
            SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
            SUM(CASE WHEN status = 'confirmed' AND substr(doc_date, 1, 7) = ? THEN 1 ELSE 0 END) AS month_count,
            COALESCE(SUM(CASE WHEN status = 'confirmed' AND substr(doc_date, 1, 7) = ? THEN total_amount END), 0) AS month_amount
       FROM ${table} WHERE store_id = :store GROUP BY company_id`, [month, month]));
  const [purchases, orders, topVendors, recent] = await Promise.all([
    perCompany('purchases'), perCompany('orders'),
    rows(s.prepare(
      `SELECT vendor_id, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS amount FROM purchases
        WHERE store_id = :store AND status = 'confirmed' AND substr(doc_date, 1, 7) = ?
        GROUP BY vendor_id ORDER BY amount DESC LIMIT 5`, [month])),
    rows(s.prepare(
      `SELECT * FROM (
         SELECT 'purchase' AS kind, id, company_id, doc_date, vendor_id AS party_id, vendor_doc_no AS doc_no, total_amount, confirmed_at FROM purchases WHERE store_id = :store AND status = 'confirmed'
         UNION ALL
         SELECT 'order' AS kind, id, company_id, doc_date, customer_id AS party_id, sales_no AS doc_no, total_amount, confirmed_at FROM orders WHERE store_id = :store AND status = 'confirmed'
       ) ORDER BY confirmed_at DESC LIMIT 10`)),
  ]);
  return { purchases, orders, top_vendors: topVendors, recent };
}

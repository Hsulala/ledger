// 對帳單用的查詢。自訂 SQL 只能放在 src/db。s 是帶買方公司的 scope。
const IN_CHUNK = 90;

export async function confirmedOrdersUpTo(s, upTo) {
  const { results } = await s.prepare(
    `SELECT id, customer_id, sales_no, doc_date, salesperson, invoice_no, total_amount, tax_amount, note
     FROM orders WHERE store_id = :store AND company_id = ? AND status = 'confirmed' AND doc_date IS NOT NULL AND doc_date <= ?
     ORDER BY doc_date, sales_no`, [s.companyId, upTo]).all();
  return results;
}

export async function paymentsUpTo(s, upTo) {
  const { results } = await s.prepare(
    `SELECT id, customer_id, paid_on, amount, method, note FROM customer_payments
     WHERE store_id = :store AND company_id = ? AND paid_on <= ? ORDER BY paid_on, created_at`, [s.companyId, upTo]).all();
  return results;
}

export async function openings(s) {
  const { results } = await s.prepare('SELECT id, customer_id, as_of, amount FROM customer_openings WHERE store_id = :store AND company_id = ?', [s.companyId]).all();
  return results;
}

export async function allCustomers(s) {
  const { results } = await s.prepare('SELECT id, code, name, bill_to_name, billing_day, tax_rate_pct, active FROM customers WHERE store_id = :store ORDER BY code', []).all();
  return results;
}

export async function itemsOfOrders(s, orderIds) {
  const out = [];
  for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
    const ids = orderIds.slice(i, i + IN_CHUNK);
    const { results } = await s.prepare(
      `SELECT oi.order_id, oi.position, oi.line_type, oi.raw_name, oi.qty, oi.unit, oi.unit_price_x100, oi.amount, p.sku AS sku, p.name AS product_name
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id AND p.store_id = oi.store_id
       WHERE oi.store_id = :store AND oi.order_id IN (${ids.map(() => '?').join(',')}) ORDER BY oi.order_id, oi.position`, ids).all();
    out.push(...results);
  }
  return out;
}

export async function setOpening(s, { customerId, asOf, amount, at }) {
  await s.prepare(
    `INSERT INTO customer_openings (id, store_id, company_id, customer_id, as_of, amount, created_at) VALUES (?, :store, ?, ?, ?, ?, ?)
     ON CONFLICT (store_id, company_id, customer_id) DO UPDATE SET as_of = excluded.as_of, amount = excluded.amount`,
    [crypto.randomUUID(), s.companyId, customerId, asOf, amount, at]).run();
}

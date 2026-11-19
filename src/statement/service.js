// 把資料庫查到的單據、收款、客戶資料組成對帳單。（不含 SQL）
import { allCustomers, confirmedOrdersUpTo, itemsOfOrders, openings, paymentsUpTo } from '../db/statements.js';
import { buildStatement, periodOf, taxOf } from './calc.js';

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function lastDayOfMonth(month) {
  return periodOf(month, 0).end;
}

// 請款客戶：客戶有填「請款客戶」且找得到同名客戶，就歸在那個客戶底下，否則自己就是請款客戶
function billingResolver(customers) {
  const byName = new Map();
  for (const c of customers) if (!byName.has(c.name)) byName.set(c.name, c);
  const byId = new Map(customers.map((c) => [c.id, c]));
  const target = (c) => { const t = c?.bill_to_name ? byName.get(c.bill_to_name) : null; return t && t.id !== c.id ? t.id : c?.id; };
  return { byId, target };
}

async function loadBase(s, month) {
  const upTo = lastDayOfMonth(month);
  const [customers, orders, payments, opens] = await Promise.all([allCustomers(s), confirmedOrdersUpTo(s, upTo), paymentsUpTo(s, upTo), openings(s)]);
  const { byId, target } = billingResolver(customers);
  const groups = new Map(); // 請款客戶 id → { docs, payments, opening }
  const group = (id) => { if (!groups.has(id)) groups.set(id, { docs: [], payments: [], opening: null }); return groups.get(id); };
  for (const o of orders) {
    const t = target(byId.get(o.customer_id));
    if (!t) continue;
    const rate = byId.get(t)?.tax_rate_pct ?? 0;
    const amount = o.total_amount ?? 0;
    group(t).docs.push({ id: o.id, customer_id: o.customer_id, sales_no: o.sales_no, doc_date: o.doc_date, salesperson: o.salesperson, invoice_no: o.invoice_no, note: o.note, amount, tax: o.tax_amount ?? taxOf(amount, rate) });
  }
  for (const p of payments) group(target(byId.get(p.customer_id)) ?? p.customer_id).payments.push(p);
  for (const op of opens) group(target(byId.get(op.customer_id)) ?? op.customer_id).opening = op;
  return { byId, groups, customers, target };
}

const periodFor = (customer, month) => periodOf(month, customer?.billing_day);

export async function statementList(s, month) {
  const { byId, groups } = await loadBase(s, month);
  const rows = [];
  for (const [id, g] of groups) {
    const customer = byId.get(id);
    if (!customer) continue;
    const { start, end } = periodFor(customer, month);
    const st = buildStatement({ docs: g.docs, opening: g.opening, payments: g.payments, start, end });
    if (!st.rows.length && st.grand_unpaid <= 0) continue;
    rows.push({ customer_id: id, code: customer.code, name: customer.name, billing_day: customer.billing_day, tax_rate_pct: customer.tax_rate_pct, start, end, doc_count: st.rows.length, receivable: st.totals.receivable, prev_balance: st.prev_balance, grand_unpaid: st.grand_unpaid, prepaid: st.prepaid });
  }
  rows.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return rows;
}

export async function statementOf(s, customerId, month) {
  const { byId, groups, target } = await loadBase(s, month);
  const targetId = target(byId.get(customerId));
  const customer = byId.get(targetId);
  if (!customer) return null;
  const g = groups.get(targetId) ?? { docs: [], payments: [], opening: null };
  const { start, end } = periodFor(customer, month);
  const st = buildStatement({ docs: g.docs, opening: g.opening, payments: g.payments, start, end });
  const items = await itemsOfOrders(s, st.rows.map((r) => r.id));
  const byOrder = new Map();
  for (const it of items) (byOrder.get(it.order_id) ?? byOrder.set(it.order_id, []).get(it.order_id)).push(it);
  return {
    customer: { id: customer.id, code: customer.code, name: customer.name, billing_day: customer.billing_day, tax_rate_pct: customer.tax_rate_pct },
    month, start, end, opening: g.opening ? { as_of: g.opening.as_of, amount: g.opening.amount } : null,
    ...st,
    rows: st.rows.map((r) => ({ ...r, shop: r.customer_id === targetId ? '' : (byId.get(r.customer_id)?.name ?? ''), items: byOrder.get(r.id) ?? [] })),
    payments: g.payments.slice(-50),
  };
}

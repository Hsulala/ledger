// 客戶對帳單的計算規則（純函式，金額一律整數元）。AI 不參與。
// 規則：
//  1. 稅額：單據自己有填稅額就用它；否則「單據未稅金額 x 稅率」四捨五入到元（0.5 進位），每張單各自算、再加總。
//  2. 收款沖銷：先進先出。所有收款加總後，從最早的未收單據（含期初餘額）開始沖。
//  3. 前期＝本期開始前所有單據的未收餘額（只計本期開始前已收到的款）。
//  4. 本期收款若超過前期，會繼續沖本期單據；全部沖完仍有剩餘，記為預收。

export const taxOf = (amount, ratePct) => {
  if (!ratePct || !amount) return 0;
  const sign = amount < 0 ? -1 : 1;
  const a = Math.abs(amount);
  return sign * Math.floor((2 * a * ratePct + 100) / 200);
};

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function dayBefore(date) {
  const [y, m, d] = date.split('-').map(Number);
  return ymd(new Date(Date.UTC(y, m - 1, d - 1)));
}

// month 是「結帳區間結束那個月」。billingDay 空白或 0＝日曆月。
export function periodOf(month, billingDay) {
  const [y, m] = month.split('-').map(Number);
  if (!billingDay) return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
  const prev = new Date(Date.UTC(y, m - 2, 1));
  return { start: `${ymd(prev).slice(0, 8)}${pad(billingDay + 1)}`, end: `${y}-${pad(m)}-${pad(billingDay)}` };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// docs: [{ id, doc_date, sales_no, amount, tax }]；opening: { as_of, amount } 或 null；payments: [{ paid_on, amount }]
export function buildStatement({ docs, opening, payments, start, end }) {
  const entries = [];
  if (opening && opening.amount) entries.push({ kind: 'opening', date: opening.as_of, receivable: opening.amount, doc: null });
  for (const d of docs) if (d.doc_date <= end) entries.push({ kind: 'doc', date: d.doc_date, receivable: d.amount + d.tax, doc: d });
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? String(a.doc?.sales_no ?? '').localeCompare(String(b.doc?.sales_no ?? '')) : a.kind === 'opening' ? -1 : 1));

  const prevDate = dayBefore(start);
  const paidUpTo = (date) => payments.filter((p) => p.paid_on <= date).reduce((s, p) => s + p.amount, 0);
  const pPrev = paidUpTo(prevDate), pEnd = paidUpTo(end);

  let before = 0; // 排在前面的單據應收累計
  let prevBalance = 0, prevPaidInPeriod = 0, grandUnpaid = 0;
  const rows = [];
  for (const e of entries) {
    const paidEnd = clamp(pEnd - before, 0, e.receivable);
    const paidPrev = clamp(pPrev - before, 0, e.receivable);
    before += e.receivable;
    grandUnpaid += e.receivable - paidEnd;
    if (e.date < start) {
      prevBalance += e.receivable - paidPrev;
      prevPaidInPeriod += paidEnd - paidPrev;
    } else if (e.kind === 'doc') {
      rows.push({ ...e.doc, receivable: e.receivable, paid: paidEnd, unpaid: e.receivable - paidEnd });
    }
  }
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  return {
    prev_balance: prevBalance,
    prev_paid_in_period: prevPaidInPeriod,
    rows,
    totals: { amount: sum('amount'), tax: sum('tax'), receivable: sum('receivable'), paid: sum('paid') },
    prepaid: Math.max(0, pEnd - before),
    grand_unpaid: grandUnpaid,
    period_payments: payments.filter((p) => p.paid_on >= start && p.paid_on <= end),
  };
}

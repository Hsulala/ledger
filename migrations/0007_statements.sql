-- 客戶對帳單（應收帳款）：結帳日、稅率、期初餘額、收款備註。只加不改。
-- 結帳日 billing_day：空白或 0 代表日曆月（1 日到月底）；1 到 28 代表每月該日截止（例如 25：上月 26 日到本月 25 日）。
-- 稅率 tax_rate_pct 放在「請款客戶」上，底下所有分店的單據一律照這個稅率算（單據自己填了稅額則以單據為準）。
ALTER TABLE customers ADD COLUMN billing_day INTEGER;
ALTER TABLE customers ADD COLUMN tax_rate_pct INTEGER NOT NULL DEFAULT 0;

ALTER TABLE customer_payments ADD COLUMN method TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_payments ADD COLUMN note TEXT NOT NULL DEFAULT '';

-- 切換到帳房時，每家買方公司對每個請款客戶的期初未收餘額（對帳單的「前期」起點）
CREATE TABLE customer_openings (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id  TEXT NOT NULL REFERENCES companies (id),
  customer_id TEXT NOT NULL REFERENCES customers (id),
  as_of       TEXT NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount      INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (store_id, company_id, customer_id)
);

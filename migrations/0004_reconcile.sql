-- 對帳與付款（L4 使用；L1 先把結構建好，全部帶 store_id，需要分公司的表帶 company_id）

CREATE TABLE returns (
  id               TEXT PRIMARY KEY,
  store_id         TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id       TEXT NOT NULL REFERENCES companies (id),
  purchase_id      TEXT REFERENCES purchases (id),
  purchase_item_id TEXT REFERENCES purchase_items (id),
  return_date      TEXT NOT NULL,
  qty              INTEGER,
  deduct_amount    INTEGER,
  reason           TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deducted')),
  created_at       TEXT NOT NULL
);

CREATE TABLE daily_notes (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id  TEXT NOT NULL REFERENCES companies (id),
  note_date   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('return', 'defect', 'other')),
  body        TEXT NOT NULL,
  purchase_id TEXT REFERENCES purchases (id),
  order_id    TEXT REFERENCES orders (id),
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE vendor_payments (
  id         TEXT PRIMARY KEY,
  store_id   TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies (id),
  vendor_id  TEXT NOT NULL REFERENCES vendors (id),
  paid_on    TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  method     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE vendor_statements (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id     TEXT NOT NULL REFERENCES companies (id),
  vendor_id      TEXT NOT NULL REFERENCES vendors (id),
  month          TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  vendor_total   INTEGER,
  source_file_id TEXT REFERENCES source_files (id),
  status         TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'recognized', 'confirmed', 'compared')),
  created_at     TEXT NOT NULL
);

CREATE TABLE statement_lines (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  statement_id TEXT NOT NULL REFERENCES vendor_statements (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  doc_date     TEXT,
  doc_no       TEXT NOT NULL DEFAULT '',
  raw_name     TEXT NOT NULL DEFAULT '',
  qty          INTEGER,
  amount       INTEGER,
  flags        TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE statement_diffs (
  id            TEXT PRIMARY KEY,
  store_id      TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  statement_id  TEXT NOT NULL REFERENCES vendor_statements (id) ON DELETE CASCADE,
  diff_type     TEXT NOT NULL CHECK (diff_type IN ('amount', 'missing', 'extra', 'return_not_deducted', 'possible_duplicate')),
  purchase_id   TEXT REFERENCES purchases (id),
  our_amount    INTEGER,
  vendor_amount INTEGER,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE customer_payments (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id  TEXT NOT NULL REFERENCES companies (id),
  customer_id TEXT NOT NULL REFERENCES customers (id),
  paid_on     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'received' CHECK (kind IN ('received', 'prepaid')),
  created_at  TEXT NOT NULL
);

CREATE TABLE customer_statements (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL REFERENCES companies (id),
  customer_id  TEXT NOT NULL REFERENCES customers (id),
  month        TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  prior_unpaid INTEGER NOT NULL DEFAULT 0,
  prepaid      INTEGER NOT NULL DEFAULT 0,
  total_due    INTEGER NOT NULL DEFAULT 0,
  snapshot     TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'checked', 'invoiced')),
  created_at   TEXT NOT NULL
);

CREATE TABLE ai_usage (
  id               TEXT PRIMARY KEY,
  store_id         TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  model            TEXT NOT NULL,
  purpose          TEXT NOT NULL DEFAULT '',
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros  INTEGER NOT NULL DEFAULT 0,
  at               TEXT NOT NULL
);
CREATE INDEX idx_ai_usage_store_at ON ai_usage (store_id, at);

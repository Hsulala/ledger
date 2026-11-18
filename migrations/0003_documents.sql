-- 單據：原始檔案、判讀結果、進貨單、訂單。company_id 讓兩家買方公司一定分開。

CREATE TABLE source_files (
  id            TEXT PRIMARY KEY,
  store_id      TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies (id),
  r2_key        TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  mime          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  page_no       INTEGER NOT NULL DEFAULT 1 CHECK (page_no >= 1),
  doc_kind      TEXT CHECK (doc_kind IS NULL OR doc_kind IN ('purchase', 'order', 'statement', 'note')),
  doc_id        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached', 'discarded')),
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (store_id, sha256)
);
CREATE INDEX idx_files_doc ON source_files (store_id, doc_kind, doc_id);
CREATE INDEX idx_files_pending ON source_files (store_id, company_id, status);

-- AI 判讀的原始輸出與逐欄信心（L2 使用；L1 先建表）
CREATE TABLE extractions (
  id               TEXT PRIMARY KEY,
  store_id         TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  file_id          TEXT REFERENCES source_files (id) ON DELETE SET NULL,
  doc_kind         TEXT,
  doc_id           TEXT,
  model            TEXT NOT NULL,
  prompt_version   TEXT NOT NULL,
  raw_output       TEXT NOT NULL,
  field_confidence TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL
);

CREATE TABLE purchases (
  id            TEXT PRIMARY KEY,
  store_id      TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies (id),
  vendor_id     TEXT NOT NULL REFERENCES vendors (id),
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('quote', 'delivery', 'shipment', 'sales')),
  vendor_doc_no TEXT NOT NULL DEFAULT '',
  doc_date      TEXT CHECK (doc_date IS NULL OR doc_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  doc_date_raw  TEXT NOT NULL DEFAULT '',
  tax_mode      TEXT NOT NULL DEFAULT 'unknown' CHECK (tax_mode IN ('excl', 'incl', 'unknown')),
  tax_amount    INTEGER,
  total_amount  INTEGER,
  source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('photo', 'text', 'web')),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  flags         TEXT NOT NULL DEFAULT '{}',
  note          TEXT NOT NULL DEFAULT '',
  created_by    TEXT,
  confirmed_by  TEXT,
  confirmed_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_purchases_list ON purchases (store_id, company_id, status, doc_date);
CREATE INDEX idx_purchases_docno ON purchases (store_id, vendor_id, vendor_doc_no);

CREATE TABLE purchase_items (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  purchase_id     TEXT NOT NULL REFERENCES purchases (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  line_type       TEXT NOT NULL DEFAULT 'product' CHECK (line_type IN ('product', 'freight', 'gift')),
  raw_name        TEXT NOT NULL DEFAULT '',
  vendor_sku      TEXT NOT NULL DEFAULT '',
  product_id      TEXT REFERENCES products (id),
  cases           INTEGER CHECK (cases IS NULL OR cases >= 0),
  packs           INTEGER CHECK (packs IS NULL OR packs >= 0),
  unit            TEXT NOT NULL DEFAULT '',
  unit_price_x100 INTEGER CHECK (unit_price_x100 IS NULL OR unit_price_x100 >= 0),
  amount          INTEGER,
  confidence      REAL,
  edited          INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  flags           TEXT NOT NULL DEFAULT '{}',
  note            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_purchase_items_parent ON purchase_items (store_id, purchase_id, position);

CREATE TABLE orders (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL REFERENCES companies (id),
  customer_id  TEXT NOT NULL REFERENCES customers (id),
  sales_no     TEXT NOT NULL DEFAULT '',
  doc_date     TEXT CHECK (doc_date IS NULL OR doc_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  doc_date_raw TEXT NOT NULL DEFAULT '',
  salesperson  TEXT NOT NULL DEFAULT '',
  tax_amount   INTEGER,
  total_amount INTEGER,
  invoice_no   TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('photo', 'text', 'web')),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  flags        TEXT NOT NULL DEFAULT '{}',
  note         TEXT NOT NULL DEFAULT '',
  created_by   TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_orders_list ON orders (store_id, company_id, status, doc_date);
CREATE INDEX idx_orders_no ON orders (store_id, company_id, sales_no);

CREATE TABLE order_items (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  order_id        TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  line_type       TEXT NOT NULL DEFAULT 'product' CHECK (line_type IN ('product', 'freight', 'gift')),
  raw_name        TEXT NOT NULL DEFAULT '',
  product_id      TEXT REFERENCES products (id),
  qty             INTEGER CHECK (qty IS NULL OR qty >= 0),
  unit            TEXT NOT NULL DEFAULT '',
  unit_price_x100 INTEGER CHECK (unit_price_x100 IS NULL OR unit_price_x100 >= 0),
  amount          INTEGER,
  confidence      REAL,
  edited          INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  flags           TEXT NOT NULL DEFAULT '{}',
  note            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_order_items_parent ON order_items (store_id, order_id, position);

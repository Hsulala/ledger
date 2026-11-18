-- 主檔：買方公司、廠商、商品、品名對照、價目表、客戶。全部帶 store_id。

CREATE TABLE companies (
  id         TEXT PRIMARY KEY,
  store_id   TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  tax_id     TEXT,
  aliases    TEXT NOT NULL DEFAULT '[]',
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (store_id, name)
);

CREATE TABLE vendors (
  id         TEXT PRIMARY KEY,
  store_id   TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  category   TEXT NOT NULL CHECK (category IN ('bedding', 'chicken_feet', 'ready_meal')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (store_id, name)
);

-- 廠商單據格式（L2 判讀規則會用；L1 先建表）
CREATE TABLE vendor_formats (
  vendor_id      TEXT PRIMARY KEY REFERENCES vendors (id) ON DELETE CASCADE,
  store_id       TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  date_format    TEXT NOT NULL DEFAULT 'mixed' CHECK (date_format IN ('roc', 'gregorian', 'mixed')),
  doc_no_rule    TEXT NOT NULL DEFAULT '',
  qty_style      TEXT NOT NULL DEFAULT 'simple' CHECK (qty_style IN ('simple', 'case_and_pack', 'piece_per_pack')),
  tax_mode       TEXT NOT NULL DEFAULT 'unknown' CHECK (tax_mode IN ('excl', 'incl', 'unknown')),
  has_unit_price INTEGER NOT NULL DEFAULT 1 CHECK (has_unit_price IN (0, 1)),
  updated_at     TEXT NOT NULL
);

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  store_id      TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  sku           TEXT,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  category      TEXT CHECK (category IS NULL OR category IN ('bedding', 'chicken_feet', 'ready_meal')),
  unit          TEXT NOT NULL DEFAULT '',
  pack_per_case INTEGER CHECK (pack_per_case IS NULL OR pack_per_case > 0),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL,
  UNIQUE (store_id, sku)
);

-- Mamie 每次修正都寫入（L2 起），下次相同寫法自動對應
CREATE TABLE vendor_item_aliases (
  id         TEXT PRIMARY KEY,
  store_id   TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  vendor_id  TEXT NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  raw_name   TEXT NOT NULL,
  vendor_sku TEXT,
  product_id TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (store_id, vendor_id, raw_name)
);

-- 單上沒寫單價的廠商用（價目表來源與維護方式尚未定案）
CREATE TABLE vendor_prices (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  vendor_id       TEXT NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,
  product_id      TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  unit_price_x100 INTEGER NOT NULL CHECK (unit_price_x100 >= 0),
  tax_mode        TEXT NOT NULL DEFAULT 'unknown' CHECK (tax_mode IN ('excl', 'incl', 'unknown')),
  effective_from  TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_vendor_prices_lookup ON vendor_prices (store_id, vendor_id, product_id, effective_from);

CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  store_id   TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  code       TEXT,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (store_id, code)
);

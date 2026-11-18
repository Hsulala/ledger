-- 帳房 ledger：系統層（店家、模組、帳號、登入階段、稽核）
-- 約定：金額為整數「元」；單價為整數「元 x 100」（欄位名 *_x100）；日期統一 YYYY-MM-DD（西元）；時間為 UTC ISO 8601。
-- 只加不改：要改結構請新增下一個編號的檔案。

CREATE TABLE stores (
  id          TEXT PRIMARY KEY CHECK (length(id) BETWEEN 2 AND 30 AND id GLOB '[a-z]*' AND id NOT GLOB '*[^a-z0-9_-]*'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  theme_color TEXT CHECK (theme_color IS NULL OR theme_color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 模組代碼 ledger 的子功能開關（沒有紀錄＝依程式內的預設值）
CREATE TABLE store_modules (
  store_id   TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, module_key)
);

-- 每店設定（例如 AI 每月上限；數值尚未定案，先留位置）
CREATE TABLE store_settings (
  store_id   TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_id, key)
);

-- 給 Hub 讀取狀態與用量用的金鑰（只存雜湊；L5 才會使用）
CREATE TABLE store_remote_keys (
  store_id       TEXT PRIMARY KEY REFERENCES stores (id) ON DELETE CASCADE,
  read_key_hash  TEXT,
  write_key_hash TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE store_users (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  role         TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff')),
  line_user_id TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at   TEXT NOT NULL,
  UNIQUE (store_id, line_user_id)
);
CREATE INDEX idx_store_users_line ON store_users (line_user_id);

-- 一次性綁定連結（只存權杖雜湊）
CREATE TABLE invites (
  id         TEXT PRIMARY KEY,
  store_id   TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES store_users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('admin', 'store')),
  admin_id   TEXT REFERENCES admin_users (id) ON DELETE CASCADE,
  store_id   TEXT REFERENCES stores (id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES store_users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- LINE 登入的 state（防偽造回呼），用過即刪
CREATE TABLE oauth_states (
  state_hash        TEXT PRIMARY KEY,
  nonce             TEXT NOT NULL,
  invite_token_hash TEXT,
  expires_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

-- 登入失敗限流（跨 isolate 共用，所以放資料庫）
CREATE TABLE login_failures (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  first_at      INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  store_id   TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  user_id    TEXT,
  actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'admin', 'system', 'ai')),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  at         TEXT NOT NULL
);
CREATE INDEX idx_audit_store_at ON audit_log (store_id, at DESC);
CREATE INDEX idx_audit_entity ON audit_log (store_id, entity, entity_id);

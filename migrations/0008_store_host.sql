-- 帳房 ledger：每家店可有專屬網址（hostname），Worker 依請求的網址決定是哪一家店。
-- host 為純主機名稱（小寫、不含 https:// 與連接埠），例如 mamie.kulalab.app；沒有設定的店家只能從通用網址（後台所在網址）登入。
ALTER TABLE stores ADD COLUMN host TEXT CHECK (host IS NULL OR (length(host) BETWEEN 4 AND 100 AND host = lower(host) AND host NOT GLOB '*[^a-z0-9.-]*'));
CREATE UNIQUE INDEX idx_stores_host ON stores (host) WHERE host IS NOT NULL;

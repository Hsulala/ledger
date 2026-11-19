-- 鼎新主檔匯入用欄位（只加不改）。
-- 廠商：保留鼎新的代號、聯絡資料與原分類（寢具／食品／其他）。category 欄位的選項只有寢具、鳳爪、調理包，
-- 食品類廠商暫以 ready_meal 填入，實際分類以 group_name 為準。
ALTER TABLE vendors ADD COLUMN legacy_code TEXT;
ALTER TABLE vendors ADD COLUMN phone TEXT;
ALTER TABLE vendors ADD COLUMN contact TEXT;
ALTER TABLE vendors ADD COLUMN address TEXT;
ALTER TABLE vendors ADD COLUMN group_name TEXT;

-- 商品：原分類與零售價（元 x100）。不匯入鼎新的庫存量與標準進價（不可信）。
ALTER TABLE products ADD COLUMN group_name TEXT;
ALTER TABLE products ADD COLUMN list_price_x100 INTEGER;

-- 客戶：聯絡資料、統編、請款客戶名稱（對帳單用）與客戶類型（正式／潛在）。
ALTER TABLE customers ADD COLUMN tax_id TEXT;
ALTER TABLE customers ADD COLUMN bill_to_name TEXT;
ALTER TABLE customers ADD COLUMN phone TEXT;
ALTER TABLE customers ADD COLUMN mobile TEXT;
ALTER TABLE customers ADD COLUMN contact TEXT;
ALTER TABLE customers ADD COLUMN address TEXT;
ALTER TABLE customers ADD COLUMN customer_type TEXT;

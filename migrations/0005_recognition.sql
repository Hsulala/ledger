-- L2：單據判讀。廠商與客戶補統編與別名，讓程式能用單據上的名稱與統編自動對應。
ALTER TABLE vendors ADD COLUMN tax_id TEXT;
ALTER TABLE vendors ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
ALTER TABLE customers ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';

-- 判讀結果補欄位：這次判讀用到的檔案、處理狀態（尚未建草稿時可重新比對，不必再呼叫 AI）
ALTER TABLE extractions ADD COLUMN file_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE extractions ADD COLUMN company_id TEXT;
ALTER TABLE extractions ADD COLUMN status TEXT NOT NULL DEFAULT 'extracted';

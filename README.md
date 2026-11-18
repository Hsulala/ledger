# 帳房（ledger）

進銷存對帳系統。Cloudflare Workers + D1 + R2。本階段為 L1：資料層與網頁基礎。

## 本機預覽（不需 Cloudflare 帳號）

    node --no-warnings scripts/dev-server.mjs
    # 店家端 http://localhost:8787/__dev/login
    # 後台 http://localhost:8787/admin.html （admin / admin-password-1）

## 測試

    npm test

## 部署前準備

1. 建立 D1 資料庫 `ledger`，把 database_id 填入 wrangler.jsonc。
2. 建立 R2 bucket `ledger-files`。
3. 設定 secrets（wrangler secret put）：SESSION_SECRET、ADMIN_PASSWORD（及選填 ADMIN_USERNAME）、LINE_LOGIN_CHANNEL_ID、LINE_LOGIN_CHANNEL_SECRET。
4. LINE Login channel 的 Callback URL 填 `https://<網址>/auth/line/callback`。
5. 在 GitHub 設定 Secrets：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID。之後每次推送到 main，測試通過會自動執行 migration 並部署。

注意：正式環境不可設定 DEV_LOGIN。

## 規則

- 資料一律經 src/db 的範圍層存取（store_id、company_id 強制帶入），測試會掃描原始碼確認。
- 金額為整數元；單價以 x100 整數儲存。
- AI 只讀取與整理，金額比對與對帳由程式規則處理。

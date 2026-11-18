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
5. 部署由 Cloudflare Workers Builds 負責：推送到 main 即自動執行 `wrangler d1 migrations apply DB --remote && wrangler deploy`（在 Cloudflare 的建置設定中設定部署命令）。GitHub Actions 只跑測試。

注意：正式環境不可設定 DEV_LOGIN。

## 規則

- 資料一律經 src/db 的範圍層存取（store_id、company_id 強制帶入），測試會掃描原始碼確認。
- 金額為整數元；單價以 x100 整數儲存。
- AI 只讀取與整理，金額比對與對帳由程式規則處理。

## 單據判讀（L2）

需要在 Cloudflare 設定 secret `ANTHROPIC_API_KEY`（選填 `AI_MODEL`，預設 claude-sonnet-5-5），並在後台為該店開啟「單據判讀」。每家店每月上限預設 300 份，可在後台調整。AI 只讀欄位，金額加總與比對由程式處理，讀完一律是草稿。

# Web Access, Google Login, and User Admin

## Goal

Dashboard 可以放上網，但任務內容只應由已授權的 Google 帳號查看。第一版不是完整多租戶系統，而是一個受 Google OAuth 保護的個人工作區：管理員可加入/停用可登入帳號。

## Current Design

- `DASHBOARD_AUTH_ENABLED=false` 時，維持本機開發模式，不需要登入。
- `DASHBOARD_AUTH_ENABLED=true` 時：
  - `/`、靜態 Dashboard 和 `/api/*` 都需要登入。
  - `/login` 提供 Google OAuth 登入入口。
  - `/api/admin/users` 只允許 `admin` 角色使用。
- 第一批管理員由 `DASHBOARD_ADMIN_EMAILS` 建立，預設是 `kevin@region.mo`。
- Session 存在 SQLite 的 `dashboard_sessions`，瀏覽器只保存 HttpOnly cookie。

## Google OAuth Redirect URIs

同一個 Google OAuth Client 可以同時用於 Dashboard login 和 Google Calendar read-only 授權。Google Cloud OAuth Client 需要加入：

- `https://你的網域/oauth/google-login/callback`
- `https://你的網域/oauth/google-calendar/callback`

本機測試則使用：

- `http://127.0.0.1:8787/oauth/google-login/callback`
- `http://127.0.0.1:8787/oauth/google-calendar/callback`

## Required Environment Variables for Web Mode

```bash
DASHBOARD_AUTH_ENABLED=true
DASHBOARD_PUBLIC_ORIGIN=https://你的網域
DASHBOARD_ADMIN_EMAILS=kevin@region.mo
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
CALENDAR_ACCOUNT_EMAIL=kevin@region.mo
```

`DASHBOARD_PUBLIC_ORIGIN` 很重要：系統會用它生成 OAuth callback URL。若放在 ngrok、Cloudflare Tunnel、VPS、Render 或 Fly.io 後面，這裡要填最終公開網址。

## User Admin

Dashboard 有「用戶管理」面板：

- 加入 Google email。
- 切換一般用戶 / 管理員。
- 啟用 / 停用用戶。

目前所有授權用戶進入同一個個人工作區。若之後要讓每個人有獨立任務，需要把 `tasks`、calendar settings、Reminders sync 變成 per-user workspace。

## Calendar Connection

Google Calendar 仍是 read-only：

- Dashboard 月曆讀 Google Calendar events。
- 甘特圖把 Google Calendar events 當作 busy blocks，避免任務排進活動時間。
- 任務時間塊不寫入 Google Calendar。

## Deployment Notes

本系統目前仍依賴本機 Apple Reminders 同步，因此真正放上網時有兩種路線：

- Mac 常駐 + ngrok/Cloudflare Tunnel：保留 Reminders 同步，最符合目前架構。
- 雲端部署：Dashboard/Telegram/Google Calendar 可運作，但 Apple Reminders 同步會失效，除非另外做 iCloud/CalDAV/Shortcuts 橋接。

## Development Rule

每次完成程式、介面或文檔修改後，都要 commit 並 push 到 GitHub。

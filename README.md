# Telegram + MiniMax Personal Scheduling Assistant MVP

本機常駐的 Telegram 個人助理，使用 MiniMax API 解析中文任務輸入，並用本地 SQLite 保存任務、排程和提醒狀態。

## Setup

```bash
nvm use
npm install
cp .env.example .env
```

填入：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `MINIMAX_API_KEY`

啟動：

```bash
nvm use
npm run dev
```

需要 Node.js 20 或以上；本工作區已提供 `.nvmrc`，目前驗證使用 Node 22.22.2。

啟動後會同時開啟本地 dashboard：

`http://127.0.0.1:8787`

Telegram bot username：

`@fatcow_personal_assistant_bot`

第一版支援文字輸入；如果傳送截圖但沒有 caption，bot 會提示改用文字。若截圖有 caption，bot 會解析 caption 內容。

## Commands

- `/add <任務描述>`：新增任務草稿
- `/today`：查看今天安排
- `/week`：查看本週安排
- `/done <任務 id 或關鍵字>`：完成任務草稿
- `/move <任務 id 或關鍵字> <新要求>`：修改任務草稿
- `/plan`：產生未開始任務重排建議
- `/confirm`：套用最近一次待確認變更
- `/reject`：放棄最近一次待確認變更

非指令訊息也會交給 MiniMax 判斷意圖。所有會寫入資料庫的動作都會先預覽，確認後才生效。

## Notes

- 第一版只支援 Telegram。
- 電腦睡眠、斷網或程式停止時不會提醒。
- MiniMax 只做理解與回覆摘要；資料庫寫入和排程由本地 deterministic code 執行。

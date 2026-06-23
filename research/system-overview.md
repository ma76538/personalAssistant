# 系統總覽

## 目標

這個系統是一個本機常駐的個人排程助理，目標是幫使用者知道要做什麼、先做什麼，以及在適當時間提醒真正重要的工作。

## 主要組件

- **Dashboard**：本地網頁介面，入口是 `http://127.0.0.1:8787/`。
- **Telegram bot**：接收自然語言任務、確認變更、發送提醒。
- **MiniMax LLM adapter**：負責中文自然語言解析和摘要生成。
- **SQLite**：本地事實來源，保存任務、狀態、排程、提醒紀錄。
- **Apple Reminders adapter**：與 macOS Reminders 的 `待定 + 2分鐘完成 + 四象限` 列表同步。
- **Apple Calendar adapter**：讀取 `kevin@region.mo` 的本月日曆事件。

## 資料流

1. 使用者在 Telegram、Dashboard 或 Apple Reminders 修改任務。
2. 系統把任務寫入本地 SQLite。
3. 排程器根據本地任務重新安排未完成工作。
4. Dashboard 顯示今日先做、2 分鐘任務、四象限、待定、甘特圖、完成箱和月曆。
5. Telegram reminder tick 只針對「緊急重要」任務提醒。

## 設計原則

- LLM 不直接決定資料庫最終狀態；會先生成 pending action 或建議。
- Reminders 同步時以 Apple Reminders 為準。
- Dashboard 要減少重複資訊，避免同一任務在多個主工作區重複出現；待定和 2 分鐘任務應獨立於四象限。
- 提醒要像秘書：主動，但不把所有低價值任務都推給使用者。

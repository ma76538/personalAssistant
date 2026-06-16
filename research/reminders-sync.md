# Apple Reminders 同步機制

## 同步目標

Reminders 是任務列表的 source of truth。系統要和 macOS Reminders 中的四象限列表完全對齊。

## 同步範圍

只同步以下四類列表名稱或其粵語/中文別名：

- 緊急重要 / 緊要重要
- 緊急不重要 / 緊急唔重要 / 緊要不重要 / 緊要唔重要
- 不緊急重要 / 唔緊急重要 / 不急重要 / 唔急重要
- 不緊急不重要 / 不緊急唔重要 / 唔緊急不重要 / 唔緊急唔重要 / 不急不重要 / 唔急唔重要

四象限外的 Reminder list 不同步入系統。

## 自動同步

- 系統啟動後會立即同步一次。
- 之後每分鐘 cron 檢查一次，但預設每 5 分鐘才真正執行 Apple Reminders 同步。
- 同步過程有 lock；上一輪未完成時，下一輪會跳過。

可用 `.env` 調整：

```env
APPLE_REMINDER_SYNC_ENABLED=true
APPLE_REMINDER_SYNC_INTERVAL_MINUTES=5
APPLE_REMINDER_SYNC_LIST_NAME=全部
```

注意：即使設定了 list name，目前同步邏輯仍應只讀四象限列表，避免誤同步其他 Reminders 清單。

## 同步規則

- Reminders 未完成項目：新增或更新本地任務。
- Reminders 已完成項目：本地狀態改為 `done`。
- Reminders 已刪除或已不在四象限列表中：本地硬刪除。
- 本地未完成但沒有 Reminders source 的任務：同步時會被刪除，因為 Reminders 是 source of truth。

## 寫回 Reminders

Dashboard 或 Telegram 修改任務時，系統會寫回 Reminders：

- 標題
- notes/context
- due date
- priority
- completion status
- 所屬四象限 list
- 狀態標籤：`#待定`、`#進行中`、`#完成`

## 已發現並修正的不一致

- 過去 list name 判斷太模糊，可能把含有「重要」字樣的其他 list 當成四象限。
- 過去指定 listName 時有機會讀入四象限外的 list。
- 現在應以四象限白名單作為唯一同步範圍。


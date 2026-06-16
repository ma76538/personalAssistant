# Telegram 提醒與每日摘要

## Telegram 程式位置

- `src/index.ts`：啟動 Telegram bot、dashboard、cron tick。
- `src/bot.ts`：Telegram 指令和訊息處理。
- `src/reminders.ts`：定時提醒規則。
- `src/dailyBrief.ts`：每日摘要。

Telegram bot username：

```text
@fatcow_personal_assistant_bot
```

## 提醒原則

使用者希望助理像秘書一樣主動提醒，但又不要因低價值任務造成噪音。因此目前 Telegram reminder tick 只提醒「緊急重要」任務。

## Reminder tick

每分鐘 cron 會執行 reminder tick。實際發送會根據提醒設定和任務排程判斷。

目前只有同時符合以下條件的任務會進入提醒流程：

- 任務未完成、未取消
- 任務有 scheduled start / end
- 任務 quadrant 是 `urgent-important`

## 每日摘要

每日摘要預設時間由 `.env` 的 `DAILY_BRIEF_TIME` 控制，預設是 `08:30`。

摘要只包含「緊急重要」任務：

- 今日緊急重要時間表
- 緊急重要先後次序
- 已過期緊急重要提醒

## 確認流程

Telegram 中涉及寫入的 LLM 任務解析仍應走 preview / confirm 流程：

- `/confirm` 套用最近一次待確認變更
- `/reject` 放棄最近一次待確認變更


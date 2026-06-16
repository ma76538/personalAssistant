# 一致性檢查與已知限制

## 已檢查的不一致

### Reminders 同步範圍

問題：過去 Reminders list 判斷太模糊，且指定 listName 時可能讀入四象限外的 list。

修正方向：只用四象限白名單同步。四象限外 Reminder list 不進本地系統。

### Dashboard 任務重複

問題：2 分鐘任務如果同時出現在 2 分鐘區和四象限，使用者會以為有兩個任務。

修正方向：2 分鐘任務獨立顯示，不再同時出現在四象限。

### 今日時間線語意不明

問題：使用者不清楚「今日時間線」用途。

修正方向：移除今日時間線，改為每月日曆。今日工作重點保留在「今日先做」。

### Calendar 授權

問題：已加入 `kevin@region.mo` Calendar adapter，但目前 macOS 未授權 EventKit 讀取 Calendar。

目前行為：Dashboard 顯示未連結狀態，不會 crash。

## 已知限制

- 電腦睡眠、斷網或程式停止時，不會自動提醒或同步。
- Apple Reminders 是 source of truth；本地未同步到 Reminders 的 active 任務可能在同步時被刪除。
- Calendar 目前只讀取，不寫入。
- Telegram 每日提醒只提醒緊急重要事項，其他象限需在 Dashboard 查看。
- LLM 解析仍可能出錯，因此寫入前應保留確認流程。

## 建議驗收清單

- Reminders 四個列表內容和 Dashboard 四象限完全一致。
- 四象限外 Reminders list 不出現在 Dashboard。
- 2 分鐘任務只出現在「2 分鐘完成」區。
- 完成 2 分鐘任務後，任務進入完成箱。
- 月曆能顯示本地排程任務。
- 授權 Calendar 後，月曆能顯示 `kevin@region.mo` 事件。


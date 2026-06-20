# Personal Assistant Research Notes

這個資料夾記錄目前個人排程助理的研究、設計決策和已知限制。它不是操作手冊，而是之後繼續開發時用來理解系統方向的入口。

## 文件索引

- [系統總覽](./system-overview.md)
- [Apple Reminders 同步機制](./reminders-sync.md)
- [Dashboard 與任務操作設計](./dashboard-design.md)
- [Telegram 提醒與每日摘要](./telegram-reminders.md)
- [Apple Calendar / kevin@region.mo 月曆整合](./calendar-integration.md)
- [LLM 任務梳理、提醒與經驗沉澱](./llm-workflow-experience.md)
- [一致性檢查與已知限制](./consistency-and-known-issues.md)

## 目前核心結論

- Apple Reminders 是任務同步的 source of truth。
- 同步範圍只應包含四個 Reminders 四象限列表，四象限外的 Reminder list 不應同步入系統。
- Dashboard 的主要操作界面是四象限；2 分鐘任務獨立顯示，避免在四象限重複出現。
- Telegram 每日摘要和定時提醒只應提醒「緊急重要」事項，降低噪音。
- 月曆視圖應結合本地已排程任務和 `kevin@region.mo` Apple Calendar events。
- LLM 應負責理解、排序建議、追問和經驗沉澱；真正改任務或排程前仍要 preview / confirm。

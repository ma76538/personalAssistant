# Personal Assistant Research Notes

這個資料夾記錄目前個人排程助理的研究、設計決策和已知限制。它不是操作手冊，而是之後繼續開發時用來理解系統方向的入口。

## 文件索引

- [系統總覽](./system-overview.md)
- [對話壓縮版決策紀錄](./conversation-condensed-decisions.md)
- [Apple Reminders 同步機制](./reminders-sync.md)
- [Dashboard 與任務操作設計](./dashboard-design.md)
- [Telegram 提醒與每日摘要](./telegram-reminders.md)
- [Apple Calendar / kevin@region.mo 月曆整合](./calendar-integration.md)
- [Web Access、Google Login 與用戶管理](./web-auth-and-user-admin.md)
- [LLM 任務梳理、提醒與經驗沉澱](./llm-workflow-experience.md)
- [任務子項目與跟進機制](./subtask-followup-mechanism.md)
- [Deadline 與 Next Review 設計](./deadline-vs-next-review.md)
- [電子秘書任務收納框架](./task-container-framework.md)
- [一致性檢查與已知限制](./consistency-and-known-issues.md)

## 目前核心結論

- Apple Reminders 是任務同步的 source of truth。
- 同步範圍只應包含 `待定 + 2分鐘完成 + 四個 Reminders 四象限列表`，其他 Reminder list 不應同步入系統。
- Dashboard 的主要操作界面是四象限；2 分鐘任務獨立顯示，待定任務壓縮在四象限下方。
- Telegram 每日摘要和定時提醒只應提醒「緊急重要」事項，降低噪音。
- 月曆視圖應結合任務 Due Date 和 `kevin@region.mo` Google Calendar events；Google Calendar 是 read-only busy source。
- Dashboard 上網模式應使用 Google OAuth 登入，用戶管理由後台控制。
- LLM 應負責理解、排序建議、追問和經驗沉澱；真正改任務或排程前仍要 preview / confirm。
- 有外部後果才填 Due Date；沒有硬期限但需要持續推進的長項目使用 Next Review。
- 先判斷事項放入哪個容器：待定、2 分鐘完成、單步任務、長項目 / Project、Calendar 活動。

## 開發工作規則

- 每次完成任何程式、介面或文檔修改後，都要 commit 並 push 到 GitHub，確保本機與遠端 repository 保持一致。

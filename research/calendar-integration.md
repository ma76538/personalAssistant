# Apple Calendar / kevin@region.mo 月曆整合

## 目標

Dashboard 應提供每月日曆，並連接 `kevin@region.mo` 的 Apple Calendar events。

## 月曆內容

每月日曆混合顯示兩種資料：

- 本地已排程任務：來自 SQLite 排程結果。
- Apple Calendar events：來自 macOS Calendar 中 `kevin@region.mo` 相關 source 或 calendar。

## Calendar adapter

Calendar adapter 使用 macOS EventKit 讀取 events：

- 只讀取 source title 或 calendar title 包含 `kevin@region.mo` 的日曆。
- 讀取範圍是本月第一天到下月第一天。
- 未授權或找不到 calendar 時，Dashboard 不應 crash，而是顯示未連結狀態。

## 目前觀察

在目前機器上，EventKit 回傳：

```text
Calendar access was not granted.
```

所以程式層已接好 `kevin@region.mo`，但 macOS 尚未授權目前執行環境讀取 Calendar。授權後，月曆會自動顯示事件。

## 後續可改進

- 在 Dashboard 顯示更友善的授權提示。
- 加入「重新檢查 Calendar 權限」按鈕。
- 若未來要雙向同步 Calendar，需另外設計事件寫入和衝突策略。目前只做讀取。


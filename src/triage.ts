import { Quadrant, SubtaskDecomposition, Task, TaskTriageResult } from "./types.js";

const HARD_URGENT_DAYS = 3;
const URGENCY_BUFFER_MINUTES = 60;

export function isImportantTask(task: Pick<Task, "valueScore" | "deadlineType">, secretaryMvpMode = false): boolean {
  return secretaryMvpMode && task.valueScore >= 5 ? true : task.valueScore >= 3 || task.deadlineType === "hard";
}

export function isUrgentTask(task: Pick<Task, "deadline" | "deadlineType" | "durationMinutes">, now = new Date(), dailyWorkCapacityHours = 3): boolean {
  if (!task.deadline || task.deadlineType !== "hard") return false;
  const deadline = new Date(task.deadline);
  if (!Number.isFinite(deadline.getTime())) return false;
  const remainingMs = deadline.getTime() - now.getTime();
  if (remainingMs <= 0) return true;
  if (remainingMs <= HARD_URGENT_DAYS * 24 * 60 * 60 * 1000) return true;

  const remainingDays = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
  const availableMinutes = remainingDays * dailyWorkCapacityHours * 60;
  return task.durationMinutes + URGENCY_BUFFER_MINUTES > availableMinutes;
}

export function deriveQuadrant(task: Pick<Task, "deadline" | "deadlineType" | "durationMinutes" | "valueScore">, options: { now?: Date; dailyWorkCapacityHours?: number; secretaryMvpMode?: boolean } = {}): Quadrant {
  const important = isImportantTask(task, options.secretaryMvpMode ?? false);
  const urgent = isUrgentTask(task, options.now ?? new Date(), options.dailyWorkCapacityHours ?? 3);
  if (urgent && important) return "urgent-important";
  if (urgent && !important) return "urgent-not-important";
  if (!urgent && important) return "not-urgent-important";
  return "not-urgent-not-important";
}

export function buildTriageSuggestion(task: Task, options: { now?: Date; dailyWorkCapacityHours?: number; secretaryMvpMode?: boolean } = {}): TaskTriageResult {
  const recommendedQuadrant = task.deadline || task.valueScore >= 3 ? deriveQuadrant(task, options) : null;
  const questions: string[] = [];
  if (!task.deadline) questions.push("這件事有沒有 hard 或 soft deadline？");
  if (task.valueScore === 3) questions.push("這件事是否有 PO/金主，或是否符合大健康／展品設備方向？");
  if (task.durationMinutes > 90) questions.push("這是一個長任務，要不要先拆一個 60-90 分鐘下一步？");
  return {
    valueScore: task.valueScore,
    deadlineType: task.deadlineType,
    recommendedQuadrant,
    isProject: task.isProject || task.durationMinutes > 90,
    estimatedMinutes: task.durationMinutes,
    nextActionTitle: task.durationMinutes > 90 ? `下一步：推進「${task.title}」` : undefined,
    clarificationQuestions: questions,
    reason: recommendedQuadrant
      ? "根據價值分、deadline 類型、剩餘工時和每日可用時間推算。"
      : "資料不足，先保留在待定，等每日整理時補資料。"
  };
}

export function fallbackNextAction(project: Task, progressNote?: string | null) {
  const note = progressNote || project.progressNote || "";
  return {
    title: `下一步：${project.title}`,
    durationMinutes: 60,
    deadline: project.deadline,
    earliestStart: null,
    reason: note ? `根據目前進度「${note}」，先安排一個 60 分鐘可執行下一步。` : "先安排一個 60 分鐘可執行下一步，完成後再滾動拆解。"
  };
}

const MULTI_STEP_KEYWORDS = ["準備", "研究", "申請", "傾合作", "開發", "寫", "跟進", "安排", "整理", "設計", "提交", "報價", "proposal", "MOU", "合同"];
const WAITING_KEYWORDS = ["等", "等待", "回覆", "審批", "確認", "約", "會議", "合作"];

export function buildSubtaskDecomposition(task: Task, note?: string | null): SubtaskDecomposition {
  const requiresSubtasks = task.isProject || task.durationMinutes > 45 || hasAny(task.title, MULTI_STEP_KEYWORDS) || hasAny(task.context || "", WAITING_KEYWORDS);
  const taskKind: SubtaskDecomposition["taskKind"] = task.isProject || task.durationMinutes > 180 ? "project" : requiresSubtasks ? "multi-step" : "single-step";
  const completionDefinition = completionDefinitionFor(task, taskKind);
  if (!requiresSubtasks) {
    return {
      taskKind,
      requiresSubtasks: false,
      completionDefinition,
      subtasks: [],
      clarificationQuestions: task.deadline ? [] : ["如果這件事不是立即做，是否需要設定到時提醒或 Due Date？"],
      experienceRule: "2 分鐘或 30 分鐘內、完成標準清楚、無依賴的任務，保留單步處理，不必拆成子項目。",
      reason: "此任務看起來可一次完成；先不建議拆子項目。"
    };
  }

  const subtasks = templateSubtasks(task, note).map((title, index) => ({
    title,
    status: "pending" as const,
    followUpAt: null,
    completionDefinition: index === 0 ? completionDefinition : null,
    note: null
  }));

  return {
    taskKind,
    requiresSubtasks: true,
    completionDefinition,
    subtasks,
    clarificationQuestions: [
      task.deadline ? "" : "這件事有沒有 hard/soft deadline？",
      "有沒有要等待的人、文件或審批？",
      "第一個 15-90 分鐘內可完成的下一步是否正確？"
    ].filter(Boolean),
    experienceRule: experienceRuleFor(task),
    reason: "此任務包含多個工作段、模糊完成標準或等待/交付元素，建議用下一步制跟進。"
  };
}

function templateSubtasks(task: Task, note?: string | null): string[] {
  const title = task.title;
  if (hasAny(title, ["申請", "提交", "認證", "資質"])) {
    return [`確認「${title}」所需文件和完成標準`, "收集/補齊文件", "提交或交給相關人士", "設定跟進結果的時間"];
  }
  if (hasAny(title, ["傾合作", "合作", "約", "會議"])) {
    return [`列出「${title}」想達成的 1-3 個目標`, "準備對方需要看的資料", "約時間或發出跟進訊息", "會後整理下一步和責任人"];
  }
  if (hasAny(title, ["開發", "系統", "自動化", "AI", "訓練", "Create ML"])) {
    return [`定義「${title}」最小可驗收成果`, "拆出第一個可在 60-90 分鐘內完成的實作步驟", "完成後測試並記錄卡點", "根據測試結果決定下一步"];
  }
  if (hasAny(title, ["寫", "proposal", "報告", "論文", "MOU", "合同"])) {
    return [`列出「${title}」的大綱或必要章節`, "找出可重用資料或舊文件", "完成第一版草稿", "檢查缺漏並安排提交/發送"];
  }
  return [
    `定義「${title}」做到甚麼才算完成`,
    note ? `根據目前線索「${note}」做第一個下一步` : `做第一個 15-90 分鐘內可完成的下一步`,
    "完成後判斷：已完成、卡住，或需要產生下一步"
  ];
}

function completionDefinitionFor(task: Task, taskKind: SubtaskDecomposition["taskKind"]): string {
  if (taskKind === "single-step") {
    return `完成「${task.title}」並確認不需要後續跟進。`;
  }
  return `「${task.title}」的外部交付、回覆或內部完成標準已達成，且沒有未完成子項目。`;
}

function experienceRuleFor(task: Task): string {
  if (hasAny(task.title, ["申請", "提交", "認證", "資質"])) {
    return "申請/提交類任務通常拆成：確認文件 → 收集文件 → 提交 → 跟進結果。";
  }
  if (hasAny(task.title, ["傾合作", "合作", "約", "會議"])) {
    return "合作洽談類任務通常拆成：列目標 → 準備資料 → 約時間/溝通 → 會後跟進。";
  }
  if (hasAny(task.title, ["開發", "系統", "自動化", "AI", "訓練", "Create ML"])) {
    return "開發類任務通常拆成：定義驗收成果 → 實作下一步 → 測試 → 記錄卡點並再拆下一步。";
  }
  if (hasAny(task.title, ["寫", "proposal", "報告", "論文", "MOU", "合同"])) {
    return "寫作/文件類任務通常拆成：列大綱 → 找素材 → 寫第一版 → 檢查和提交。";
  }
  return "多步任務先定完成標準，再只保留一個可執行下一步，完成後再滾動跟進。";
}

function hasAny(value: string, keywords: string[]): boolean {
  const normalized = value.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

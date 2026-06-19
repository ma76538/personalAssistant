import { Quadrant, Task, TaskTriageResult } from "./types.js";

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

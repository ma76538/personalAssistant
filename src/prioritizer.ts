import { Task } from "./types.js";

export type PrioritizedTask = Task & {
  urgencyScore: number;
  urgencyLabel: "critical" | "high" | "normal" | "low";
  quadrant: "urgent-important" | "urgent-not-important" | "not-urgent-important" | "not-urgent-not-important";
  isUrgent: boolean;
  isImportant: boolean;
  reason: string;
};

export function prioritizeTasks(tasks: Task[], now = new Date()): PrioritizedTask[] {
  return tasks
    .filter((task) => !["done", "cancelled"].includes(task.status))
    .map((task) => addPriority(task, now))
    .sort((a, b) => b.urgencyScore - a.urgencyScore);
}

function addPriority(task: Task, now: Date): PrioritizedTask {
  const deadlineScore = scoreDeadline(task, now);
  const statusScore = task.status === "in_progress" ? 25 : task.status === "scheduled" ? 10 : 0;
  const energyScore = task.energy === "high" ? 8 : task.energy === "medium" ? 4 : 1;
  const urgencyScore = task.priority * 12 + deadlineScore.score + statusScore + energyScore;
  const isUrgent = deadlineScore.urgent;
  const isImportant = task.priority >= 4;

  return {
    ...task,
    urgencyScore,
    urgencyLabel: urgencyScore >= 95 ? "critical" : urgencyScore >= 70 ? "high" : urgencyScore >= 40 ? "normal" : "low",
    quadrant: quadrantFor(isUrgent, isImportant),
    isUrgent,
    isImportant,
    reason: deadlineScore.reason || `優先級 ${task.priority}，${energyLabel(task.energy)}`
  };
}

function scoreDeadline(task: Task, now: Date): { score: number; reason: string; urgent: boolean } {
  if (!task.deadline) {
    return { score: 0, reason: "", urgent: false };
  }

  const hours = (new Date(task.deadline).getTime() - now.getTime()) / 3_600_000;
  if (hours < 0) {
    return { score: 70, reason: "已過期限", urgent: true };
  }
  if (hours <= 24) {
    return { score: 55, reason: "24 小時內到期", urgent: true };
  }
  if (hours <= 72) {
    return { score: 35, reason: "3 日內到期", urgent: true };
  }
  if (hours <= 168) {
    return { score: 18, reason: "7 日內到期", urgent: false };
  }
  return { score: 8, reason: "有期限", urgent: false };
}

function quadrantFor(isUrgent: boolean, isImportant: boolean): PrioritizedTask["quadrant"] {
  if (isUrgent && isImportant) {
    return "urgent-important";
  }
  if (isUrgent && !isImportant) {
    return "urgent-not-important";
  }
  if (!isUrgent && isImportant) {
    return "not-urgent-important";
  }
  return "not-urgent-not-important";
}

function energyLabel(energy: Task["energy"]): string {
  if (energy === "high") {
    return "高能量任務";
  }
  if (energy === "low") {
    return "低能量任務";
  }
  return "中能量任務";
}

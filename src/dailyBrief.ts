import { AssistantRepository } from "./db.js";
import { prioritizeTasks } from "./prioritizer.js";
import { formatDateTime, startOfLocalDay, endOfLocalDay } from "./time.js";
import { Task } from "./types.js";

export type DailyBriefSender = (chatId: number, message: string) => Promise<void>;

export async function runDailyBriefTick(
  repo: AssistantRepository,
  chatId: number,
  send: DailyBriefSender,
  briefTime: string,
  now = new Date()
): Promise<void> {
  const briefDate = localDateKey(now);
  if (repo.hasDailyBrief(briefDate) || !isBriefTimeReached(now, briefTime)) {
    return;
  }

  await send(chatId, buildDailyBriefMessage(repo, now));
  repo.markDailyBrief(briefDate);
}

export function buildDailyBriefMessage(repo: AssistantRepository, now = new Date()): string {
  const todayTasks = repo.listScheduledBetween(startOfLocalDay(now).toISOString(), endOfLocalDay(now).toISOString());
  const prioritized = prioritizeTasks(repo.listActiveTasks(), now);
  const top = prioritized.slice(0, 5);
  const overdue = prioritized.filter((task) => task.deadline && new Date(task.deadline) < now);

  return [
    "今日工作重點",
    "",
    todayTasks.length ? "今日時間表：" : "今日暫時未有排定時間。",
    ...(todayTasks.length ? todayTasks.map((task) => `• ${formatTimeLine(task)}`) : []),
    "",
    top.length ? "建議先後次序：" : "目前沒有未完成任務。",
    ...top.map((task, index) => `${index + 1}. #${task.id} ${task.title}（${task.reason}）`),
    overdue.length ? "" : null,
    overdue.length ? `注意：有 ${overdue.length} 項已過期限。` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatTimeLine(task: Task): string {
  return `${formatDateTime(task.scheduledStart)} - ${formatDateTime(task.scheduledEnd)}｜#${task.id} ${task.title}`;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isBriefTimeReached(now: Date, briefTime: string): boolean {
  const [hours, minutes] = briefTime.split(":").map(Number);
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  return now >= target;
}

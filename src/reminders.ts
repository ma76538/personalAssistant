import { AssistantRepository } from "./db.js";
import { formatDateTime } from "./time.js";
import { ReminderPolicy, Task } from "./types.js";

export type ReminderSender = (chatId: number, message: string) => Promise<void>;

type ReminderMessageStage = "before_start" | "at_start" | "in_progress" | "at_end" | "unanswered";

type ReminderRule = {
  stage: string;
  triggerAt: Date;
  messageStage: ReminderMessageStage;
  suppressInQuietHours: boolean;
};

export async function runReminderTick(repo: AssistantRepository, chatId: number, send: ReminderSender, now = new Date()): Promise<void> {
  const policy = repo.getReminderPolicy();
  const tasks = repo.listActiveTasks().filter((task) => task.scheduledStart && task.scheduledEnd);

  for (const task of tasks) {
    for (const rule of reminderRules(task, policy)) {
      if (repo.hasReminder(task.id, rule.stage)) {
        continue;
      }
      if (rule.suppressInQuietHours && isQuietTime(now, policy)) {
        continue;
      }
      if (now >= rule.triggerAt) {
        await send(chatId, reminderMessage(task, rule.messageStage, policy, rule.stage));
        repo.markReminder(task.id, rule.stage);
      }
    }
  }
}

export function reminderRules(task: Task, policy: ReminderPolicy): ReminderRule[] {
  const start = new Date(task.scheduledStart!);
  const end = new Date(task.scheduledEnd!);
  const rules: ReminderRule[] = [];

  if (policy.beforeStart.enabled) {
    const beforeMinutes = new Set(policy.beforeStart.minutes);
    if (policy.highPriority.enabled && task.priority >= policy.highPriority.threshold) {
      for (const minute of policy.highPriority.extraBeforeStartMinutes) {
        beforeMinutes.add(minute);
      }
    }
    for (const minute of [...beforeMinutes].sort((a, b) => b - a)) {
      rules.push({
        stage: `before_start_${minute}`,
        triggerAt: offset(start, -minute),
        messageStage: "before_start",
        suppressInQuietHours: true
      });
    }
  }

  if (policy.start.enabled) {
    rules.push({ stage: "at_start", triggerAt: start, messageStage: "at_start", suppressInQuietHours: true });
  }

  if (policy.inProgress.enabled && task.durationMinutes >= policy.inProgress.minimumTaskMinutes) {
    let elapsed = policy.inProgress.intervalMinutes;
    while (elapsed < task.durationMinutes) {
      rules.push({
        stage: `in_progress_${elapsed}`,
        triggerAt: offset(start, elapsed),
        messageStage: "in_progress",
        suppressInQuietHours: true
      });
      elapsed += policy.inProgress.intervalMinutes;
    }
  }

  if (policy.end.enabled) {
    rules.push({ stage: "at_end", triggerAt: end, messageStage: "at_end", suppressInQuietHours: true });
  }

  if (policy.unanswered.enabled) {
    for (const minute of policy.unanswered.minutes) {
      rules.push({
        stage: `unanswered_${minute}`,
        triggerAt: offset(end, minute),
        messageStage: "unanswered",
        suppressInQuietHours: true
      });
    }
  }

  return rules.sort((a, b) => a.triggerAt.getTime() - b.triggerAt.getTime());
}

function offset(anchor: Date, minutes: number): Date {
  return new Date(anchor.getTime() + minutes * 60_000);
}

function isQuietTime(now: Date, policy: ReminderPolicy): boolean {
  if (!policy.quietHours.enabled) {
    return false;
  }
  const current = now.getHours() * 60 + now.getMinutes();
  const start = toMinutes(policy.quietHours.start);
  const end = toMinutes(policy.quietHours.end);
  if (start === end) {
    return false;
  }
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function reminderMessage(task: Task, stage: ReminderMessageStage, policy: ReminderPolicy, stageKey: string): string {
  if (stage === "before_start") {
    const minutes = stageKey.replace("before_start_", "");
    return `${minutes} 分鐘後開始：#${task.id} ${task.title}\n${formatDateTime(task.scheduledStart)} - ${formatDateTime(task.scheduledEnd)}`;
  }
  if (stage === "at_start") {
    const commands = policy.start.requireResponse ? `\n回覆 /start #${task.id}、/done #${task.id} 或 /snooze 15` : "";
    return `現在開始：#${task.id} ${task.title}${commands}`;
  }
  if (stage === "in_progress") {
    return `進行中確認：#${task.id} ${task.title}\n是否仍在做？完成可回 /done #${task.id}，要延後可回 /snooze 15。`;
  }
  if (stage === "at_end") {
    return `預計完成時間到了：#${task.id} ${task.title}\n完成了嗎？完成回 /done #${task.id}，未完成可回 /snooze 15。`;
  }
  return `追問：#${task.id} ${task.title}\n這件事需要完成、延後，還是重新安排？`;
}

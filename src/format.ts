import { formatDateTime } from "./time.js";
import { ScheduleItem } from "./scheduler.js";
import { Task } from "./types.js";

export function formatTask(task: Task): string {
  return `#${task.id} ${task.title}
時間：${formatDateTime(task.scheduledStart)} - ${formatDateTime(task.scheduledEnd)}
工時：${task.durationMinutes} 分鐘｜優先：${task.priority}｜能量：${task.energy}
期限：${formatDateTime(task.deadline)}
狀態：${task.status}`;
}

export function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) {
    return "目前沒有安排。";
  }
  return tasks.map(formatTask).join("\n\n");
}

export function formatSchedulePreview(tasks: Task[], plan: ScheduleItem[]): string {
  if (plan.length === 0) {
    return "目前沒有可排入的未開始任務。";
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return plan
    .map((item) => {
      const task = byId.get(item.taskId);
      return `#${item.taskId} ${task?.title ?? "未知任務"}：${formatDateTime(item.scheduledStart)} - ${formatDateTime(item.scheduledEnd)}`;
    })
    .join("\n");
}

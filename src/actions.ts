import { AssistantRepository } from "./db.js";
import { formatSchedulePreview, formatTask } from "./format.js";
import { buildSchedule } from "./scheduler.js";
import { ParsedAction, ParsedTask, PendingAction, Task } from "./types.js";

export function createPendingAction(repo: AssistantRepository, parsed: ParsedAction, now = new Date()): PendingAction {
  switch (parsed.intent) {
    case "add": {
      const taskInputs = getAddTasks(parsed);
      if (taskInputs.length === 0) {
        throw new Error(parsed.clarificationQuestion || "請提供任務標題。");
      }
      const fakeTasks = taskInputs.map((task, index) => fakeTask(task, index + 1, now));
      return {
        type: "add",
        parsedAction: parsed,
        preview: `準備新增 ${fakeTasks.length} 個任務：\n${fakeTasks.map(formatTask).join("\n\n")}\n\n回 /confirm 套用，或 /reject 放棄。`
      };
    }
    case "modify": {
      const task = requireTarget(repo, parsed.task?.target);
      return {
        type: "modify",
        parsedAction: parsed,
        preview: `準備修改任務 #${task.id} ${task.title}。\n新要求：${parsed.task?.newRequirements || parsed.task?.title || "未提供"}\n\n回 /confirm 套用，或 /reject 放棄。`
      };
    }
    case "complete": {
      const task = requireTarget(repo, parsed.task?.target || parsed.task?.title);
      return {
        type: "complete",
        parsedAction: { ...parsed, task: { ...parsed.task, target: String(task.id) } },
        preview: `準備標記完成：#${task.id} ${task.title}\n\n回 /confirm 套用，或 /reject 放棄。`
      };
    }
    case "cancel": {
      const task = requireTarget(repo, parsed.task?.target || parsed.task?.title);
      return {
        type: "cancel",
        parsedAction: { ...parsed, task: { ...parsed.task, target: String(task.id) } },
        preview: `準備取消：#${task.id} ${task.title}\n\n回 /confirm 套用，或 /reject 放棄。`
      };
    }
    case "replan": {
      const tasks = repo.listActiveTasks();
      const plan = buildSchedule(tasks, now);
      return {
        type: "replan",
        parsedAction: parsed,
        schedulePlan: plan,
        preview: `準備重排未開始任務：\n${formatSchedulePreview(tasks, plan)}\n\n回 /confirm 套用，或 /reject 放棄。`
      };
    }
    default:
      throw new Error(parsed.clarificationQuestion || "我還不確定你想做什麼，可以換個方式描述嗎？");
  }
}

export function applyPendingAction(repo: AssistantRepository, pending: PendingAction): string {
  const parsed = pending.parsedAction;

  switch (pending.type) {
    case "add": {
      const taskInputs = getAddTasks(parsed);
      if (taskInputs.length === 0) {
        throw new Error("待新增任務缺少標題。");
      }
      const created = taskInputs.map((task) =>
        repo.addTask({
          title: task.title!,
          durationMinutes: task.durationMinutes,
          deadline: task.deadline,
          earliestStart: task.earliestStart,
          priority: task.priority,
          energy: task.energy,
          context: task.context
        })
      );
      const tasks = repo.listActiveTasks();
      repo.applySchedule(buildSchedule(tasks));
      const refreshed = created.map((task) => repo.getTask(task.id)!).map(formatTask).join("\n\n");
      return `已新增 ${created.length} 個任務並更新排程：\n${refreshed}。`;
    }
    case "modify": {
      const task = requireTarget(repo, parsed.task?.target);
      const patch = parsed.task || {};
      repo.updateTask(task.id, {
        title: patch.title ?? task.title,
        durationMinutes: patch.durationMinutes ?? task.durationMinutes,
        deadline: patch.deadline ?? task.deadline,
        earliestStart: patch.earliestStart ?? task.earliestStart,
        priority: patch.priority ?? task.priority,
        energy: patch.energy ?? task.energy,
        context: patch.context ?? task.context,
        scheduledStart: null,
        scheduledEnd: null,
        status: "pending"
      });
      repo.applySchedule(buildSchedule(repo.listActiveTasks()));
      return `已修改並更新排程：\n${formatTask(repo.getTask(task.id)!)}。`;
    }
    case "complete": {
      const task = requireTarget(repo, parsed.task?.target);
      repo.updateTask(task.id, { status: "done" });
      repo.applySchedule(buildSchedule(repo.listActiveTasks()));
      return `已完成：#${task.id} ${task.title}。`;
    }
    case "cancel": {
      const task = requireTarget(repo, parsed.task?.target);
      repo.updateTask(task.id, { status: "cancelled" });
      repo.applySchedule(buildSchedule(repo.listActiveTasks()));
      return `已取消：#${task.id} ${task.title}。`;
    }
    case "replan":
      repo.applySchedule(pending.schedulePlan || buildSchedule(repo.listActiveTasks()));
      return "已套用新的未開始任務排程。";
  }
}

function getAddTasks(parsed: ParsedAction): ParsedTask[] {
  const tasks = parsed.tasks?.filter((task) => task.title) ?? [];
  if (tasks.length > 0) {
    return tasks;
  }
  return parsed.task?.title ? [parsed.task] : [];
}

function fakeTask(task: ParsedTask, id: number, now: Date): Task {
  return {
    id,
    title: task.title!,
    durationMinutes: task.durationMinutes ?? 30,
    deadline: task.deadline ?? null,
    earliestStart: task.earliestStart ?? null,
    priority: task.priority ?? 3,
    energy: task.energy ?? "medium",
    context: task.context ?? null,
    status: "pending",
    scheduledStart: null,
    scheduledEnd: null,
    quadrant: null,
    source: null,
    sourceId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function requireTarget(repo: AssistantRepository, target?: string): Task {
  if (!target) {
    throw new Error("請提供任務 id 或關鍵字。");
  }
  const task = repo.findTask(target);
  if (!task) {
    throw new Error(`找不到任務：${target}`);
  }
  return task;
}

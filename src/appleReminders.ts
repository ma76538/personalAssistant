import { execFileSync } from "node:child_process";
import { AssistantRepository } from "./db.js";

export type AppleReminderItem = {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  priority: number | null;
  completed: boolean;
};

type AppleReminderSnapshot = {
  active: AppleReminderItem[];
  tracked: Array<{ id: string; completed: boolean; exists: boolean }>;
};

export type SyncResult = {
  listName: string;
  imported: number;
  completed: number;
  cancelled: number;
  items: AppleReminderItem[];
};

const JXA_SCRIPT = `
function run(argv) {
  const listName = argv[0] || "提醒事項";
  const trackedIds = JSON.parse(argv[1] || "[]");
  const Reminders = Application("Reminders");
  const list = Reminders.lists.byName(listName);
  const reminders = list.reminders.whose({ completed: false })();
  const active = reminders.map(function (reminder) {
    const dueDate = reminder.dueDate();
    const body = reminder.body();
    const priority = reminder.priority();
    return {
      id: String(reminder.id()),
      title: String(reminder.name()),
      notes: body ? String(body) : null,
      dueDate: dueDate ? new Date(dueDate).toISOString() : null,
      priority: typeof priority === "number" ? priority : null,
      completed: Boolean(reminder.completed())
    };
  });
  const activeIds = {};
  active.forEach(function (item) { activeIds[item.id] = true; });
  const tracked = trackedIds.map(function (id) {
    if (activeIds[id]) {
      return { id: id, completed: false, exists: true };
    }
    try {
      const reminder = list.reminders.byId(id);
      if (!reminder.exists()) {
        return { id: id, completed: false, exists: false };
      }
      return { id: id, completed: Boolean(reminder.completed()), exists: true };
    } catch (error) {
      return { id: id, completed: false, exists: false };
    }
  });
  return JSON.stringify({ active: active, tracked: tracked });
}
`;

export function syncAppleReminders(repo: AssistantRepository, listName = "提醒事項"): SyncResult {
  const trackedIds = repo
    .listExternalTasks("apple-reminders")
    .map((task) => task.sourceId)
    .filter((sourceId): sourceId is string => Boolean(sourceId));
  const raw = execFileSync("osascript", ["-l", "JavaScript", "-e", JXA_SCRIPT, listName, JSON.stringify(trackedIds)], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  const snapshot = JSON.parse(raw.trim() || "{\"active\":[],\"tracked\":[]}") as AppleReminderSnapshot;
  const activeItems = snapshot.active.filter((item) => !item.completed);
  const activeSourceIds = activeItems.map((item) => item.id);
  const completedSourceIds = snapshot.tracked.filter((item) => item.exists && item.completed).map((item) => item.id);
  const knownSourceIds = [...new Set([...activeSourceIds, ...snapshot.tracked.filter((item) => item.exists).map((item) => item.id)])];

  for (const item of activeItems) {
    repo.upsertExternalTask({
      source: "apple-reminders",
      sourceId: item.id,
      title: item.title,
      deadline: item.dueDate,
      priority: mapPriority(item.priority),
      energy: "medium",
      context: item.notes
    });
  }
  const completed = repo.markExternalTasksStatus("apple-reminders", completedSourceIds, "done");
  const cancelled = repo.markMissingExternalTasksStatus("apple-reminders", knownSourceIds, "cancelled");

  return { listName, imported: activeSourceIds.length, completed, cancelled, items: activeItems };
}

function mapPriority(priority: number | null): number {
  if (priority === 1) {
    return 5;
  }
  if (priority === 5) {
    return 3;
  }
  if (priority === 9) {
    return 2;
  }
  return 3;
}

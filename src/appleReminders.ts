import { execFileSync } from "node:child_process";
import { AssistantRepository } from "./db.js";

export type AppleReminderItem = {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  priority: number | null;
};

export type SyncResult = {
  listName: string;
  imported: number;
  items: AppleReminderItem[];
};

const JXA_SCRIPT = `
function run(argv) {
  const listName = argv[0] || "提醒事項";
  const Reminders = Application("Reminders");
  const list = Reminders.lists.byName(listName);
  const reminders = list.reminders.whose({ completed: false })();
  const items = reminders.map(function (reminder) {
    const dueDate = reminder.dueDate();
    const body = reminder.body();
    const priority = reminder.priority();
    return {
      id: String(reminder.id()),
      title: String(reminder.name()),
      notes: body ? String(body) : null,
      dueDate: dueDate ? new Date(dueDate).toISOString() : null,
      priority: typeof priority === "number" ? priority : null
    };
  });
  return JSON.stringify(items);
}
`;

export function syncAppleReminders(repo: AssistantRepository, listName = "提醒事項"): SyncResult {
  const raw = execFileSync("osascript", ["-l", "JavaScript", "-e", JXA_SCRIPT, listName], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  const items = JSON.parse(raw.trim() || "[]") as AppleReminderItem[];

  for (const item of items) {
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

  return { listName, imported: items.length, items };
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

import { execFileSync } from "node:child_process";
import { AssistantRepository } from "./db.js";

export type AppleReminderItem = {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  priority: number | null;
  completed: boolean;
  listName: string;
};

type AppleReminderSnapshot = {
  active: AppleReminderItem[];
  tracked: Array<{ id: string; completed: boolean; exists: boolean }>;
};

export type SyncResult = {
  listName: string;
  imported: number;
  completed: number;
  deleted: number;
  items: AppleReminderItem[];
};

const EVENTKIT_SCRIPT = `
import EventKit
import Foundation

let requestedListName = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "全部"
let trackedRaw = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "[]"
let quadrantListNames = ["緊急重要", "緊要唔重要", "重要唔緊急", "唔急唔重要"]
let store = EKEventStore()
let accessSemaphore = DispatchSemaphore(value: 0)
var granted = false
var accessError: Error?

if #available(macOS 14.0, *) {
  store.requestFullAccessToReminders { didGrant, error in
    granted = didGrant
    accessError = error
    accessSemaphore.signal()
  }
} else {
  store.requestAccess(to: .reminder) { didGrant, error in
    granted = didGrant
    accessError = error
    accessSemaphore.signal()
  }
}

accessSemaphore.wait()
if !granted {
  throw NSError(domain: "PersonalAssistantReminders", code: 1, userInfo: [
    NSLocalizedDescriptionKey: accessError?.localizedDescription ?? "Reminders access was not granted."
  ])
}

let calendars = store.calendars(for: .reminder)
let names = calendars.map { $0.title }
let selectedCalendars: [EKCalendar]
if let requested = calendars.first(where: { $0.title == requestedListName }) {
  selectedCalendars = [requested]
} else if requestedListName == "提醒事項" || requestedListName == "全部" || requestedListName.lowercased() == "all" {
  selectedCalendars = calendars.filter { quadrantListNames.contains($0.title) }
  if selectedCalendars.isEmpty {
    throw NSError(domain: "PersonalAssistantReminders", code: 2, userInfo: [
      NSLocalizedDescriptionKey: "No quadrant reminder lists found. Available lists: " + names.joined(separator: ", ")
    ])
  }
} else {
  throw NSError(domain: "PersonalAssistantReminders", code: 3, userInfo: [
    NSLocalizedDescriptionKey: "Reminder list not found: " + requestedListName + ". Available lists: " + names.joined(separator: ", ")
  ])
}

let trackedData = Data(trackedRaw.utf8)
let trackedIds = ((try? JSONSerialization.jsonObject(with: trackedData)) as? [String]) ?? []
let selectedCalendarIds = Set(selectedCalendars.map { $0.calendarIdentifier })
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime]

func isoDate(_ components: DateComponents?) -> String? {
  guard var components else { return nil }
  if components.calendar == nil {
    components.calendar = Calendar.current
  }
  return components.date.map { formatter.string(from: $0) }
}

func reminderPayload(_ reminder: EKReminder) -> [String: Any] {
  return [
    "id": reminder.calendarItemIdentifier,
    "title": reminder.title ?? "",
    "notes": reminder.notes ?? NSNull(),
    "dueDate": isoDate(reminder.dueDateComponents) ?? NSNull(),
    "priority": reminder.priority,
    "completed": reminder.isCompleted,
    "listName": reminder.calendar.title
  ]
}

let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: selectedCalendars)
let fetchSemaphore = DispatchSemaphore(value: 0)
var activeReminders: [EKReminder] = []
store.fetchReminders(matching: predicate) { reminders in
  activeReminders = reminders ?? []
  fetchSemaphore.signal()
}
fetchSemaphore.wait()

let active = activeReminders.map { reminderPayload($0) }
let activeIds = Set(activeReminders.map { $0.calendarItemIdentifier })
let tracked = trackedIds.map { id -> [String: Any] in
  if activeIds.contains(id) {
    return ["id": id, "completed": false, "exists": true]
  }
  guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder,
        selectedCalendarIds.contains(reminder.calendar.calendarIdentifier) else {
    return ["id": id, "completed": false, "exists": false]
  }
  return ["id": id, "completed": reminder.isCompleted, "exists": true]
}

let output: [String: Any] = ["active": active, "tracked": tracked]
let data = try JSONSerialization.data(withJSONObject: output, options: [])
print(String(data: data, encoding: .utf8)!)
`;

export function syncAppleReminders(repo: AssistantRepository, listName = "全部"): SyncResult {
  const trackedIds = repo
    .listExternalTasks("apple-reminders")
    .map((task) => task.sourceId)
    .filter((sourceId): sourceId is string => Boolean(sourceId));
  const raw = execFileSync("swift", ["-e", EVENTKIT_SCRIPT, listName, JSON.stringify(trackedIds)], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  const snapshot = JSON.parse(raw.trim() || "{\"active\":[],\"tracked\":[]}") as AppleReminderSnapshot;
  const activeItems = snapshot.active.filter((item) => !item.completed);
  const activeSourceIds = activeItems.map((item) => item.id);
  const completedSourceIds = snapshot.tracked.filter((item) => item.exists && item.completed).map((item) => item.id);
  const knownSourceIds = [...new Set([...activeSourceIds, ...snapshot.tracked.filter((item) => item.exists).map((item) => item.id)])];
  const deletedSourceIds = snapshot.tracked.filter((item) => !item.exists).map((item) => item.id);

  for (const item of activeItems) {
    repo.upsertExternalTask({
      source: "apple-reminders",
      sourceId: item.id,
      title: item.title,
      deadline: item.dueDate ?? inferredDeadline(item.listName),
      priority: mapPriority(item.priority, item.listName),
      energy: "medium",
      context: item.notes
    });
  }
  const completed = repo.markExternalTasksStatus("apple-reminders", completedSourceIds, "done");
  const deleted = repo.deleteExternalTasksBySourceIds("apple-reminders", deletedSourceIds) + repo.deleteTasksMissingFromSource("apple-reminders", knownSourceIds) + repo.deleteUnsourcedActiveTasks();

  return { listName, imported: activeSourceIds.length, completed, deleted, items: activeItems };
}

function mapPriority(priority: number | null, listName = ""): number {
  const normalized = listName.toLowerCase();
  if (normalized.includes("重要") && !normalized.includes("唔重要") && !normalized.includes("不重要")) {
    return 5;
  }
  if (normalized.includes("唔重要") || normalized.includes("不重要")) {
    return 2;
  }
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

function inferredDeadline(listName: string): string | null {
  if (isUrgentList(listName)) {
    return new Date(Date.now() + 3 * 86400000).toISOString();
  }
  return null;
}

function isUrgentList(listName: string): boolean {
  return (listName.includes("緊急") || listName.includes("緊要")) && !listName.includes("唔急") && !listName.includes("不急");
}

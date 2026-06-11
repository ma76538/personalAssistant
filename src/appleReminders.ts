import { execFileSync } from "node:child_process";
import { AssistantRepository } from "./db.js";
import type { Quadrant, Task } from "./types.js";

export type AppleReminderItem = {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  priority: number | null;
  completed: boolean;
  listName: string;
  quadrant: Quadrant | null;
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
  selectedCalendars = calendars.filter { quadrantKey($0.title) != nil }
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

func quadrantKey(_ title: String) -> String? {
  let isNotImportant = title.contains("唔重要") || title.contains("不重要")
  let isImportant = title.contains("重要") && !isNotImportant
  let isNotUrgent = title.contains("唔急") || title.contains("不急") || title.contains("唔緊急") || title.contains("不緊急")
  let isUrgent = (title.contains("緊急") || title.contains("緊要")) && !isNotUrgent

  if isUrgent && isImportant { return "urgent-important" }
  if isUrgent && isNotImportant { return "urgent-not-important" }
  if isNotUrgent && isImportant { return "not-urgent-important" }
  if isNotUrgent && isNotImportant { return "not-urgent-not-important" }
  return nil
}

func reminderPayload(_ reminder: EKReminder) -> [String: Any] {
  return [
    "id": reminder.calendarItemIdentifier,
    "title": reminder.title ?? "",
    "notes": reminder.notes ?? NSNull(),
    "dueDate": isoDate(reminder.dueDateComponents) ?? NSNull(),
    "priority": reminder.priority,
    "completed": reminder.isCompleted,
    "listName": reminder.calendar.title,
    "quadrant": quadrantKey(reminder.calendar.title) ?? NSNull()
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

const EVENTKIT_WRITE_SCRIPT = `
import EventKit
import Foundation

let raw = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "{}"
let payloadData = Data(raw.utf8)
guard let payload = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any] else {
  throw NSError(domain: "PersonalAssistantReminders", code: 10, userInfo: [NSLocalizedDescriptionKey: "Invalid reminder payload"])
}

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
  throw NSError(domain: "PersonalAssistantReminders", code: 11, userInfo: [
    NSLocalizedDescriptionKey: accessError?.localizedDescription ?? "Reminders write access was not granted."
  ])
}

func quadrantKey(_ title: String) -> String? {
  let isNotImportant = title.contains("唔重要") || title.contains("不重要")
  let isImportant = title.contains("重要") && !isNotImportant
  let isNotUrgent = title.contains("唔急") || title.contains("不急") || title.contains("唔緊急") || title.contains("不緊急")
  let isUrgent = (title.contains("緊急") || title.contains("緊要")) && !isNotUrgent

  if isUrgent && isImportant { return "urgent-important" }
  if isUrgent && isNotImportant { return "urgent-not-important" }
  if isNotUrgent && isImportant { return "not-urgent-important" }
  if isNotUrgent && isNotImportant { return "not-urgent-not-important" }
  return nil
}

func dateComponents(_ iso: String?) -> DateComponents? {
  guard let iso, !iso.isEmpty else { return nil }
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let fallback = ISO8601DateFormatter()
  fallback.formatOptions = [.withInternetDateTime]
  guard let date = formatter.date(from: iso) ?? fallback.date(from: iso) else { return nil }
  return Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
}

let sourceId = payload["sourceId"] as? String
let reminder: EKReminder
if let sourceId, let existing = store.calendarItem(withIdentifier: sourceId) as? EKReminder {
  reminder = existing
} else {
  reminder = EKReminder(eventStore: store)
}

let calendars = store.calendars(for: .reminder)
if let quadrant = payload["quadrant"] as? String,
   let calendar = calendars.first(where: { quadrantKey($0.title) == quadrant }) {
  reminder.calendar = calendar
} else if reminder.calendar == nil, let calendar = calendars.first(where: { quadrantKey($0.title) != nil }) ?? store.defaultCalendarForNewReminders() {
  reminder.calendar = calendar
}

reminder.title = (payload["title"] as? String) ?? reminder.title
if payload.keys.contains("notes") {
  reminder.notes = payload["notes"] as? String
}
reminder.dueDateComponents = dateComponents(payload["deadline"] as? String)
if let status = payload["status"] as? String {
  reminder.isCompleted = status == "done"
}
if let priority = payload["priority"] as? Int {
  if priority >= 5 {
    reminder.priority = 1
  } else if priority >= 3 {
    reminder.priority = 5
  } else {
    reminder.priority = 9
  }
}

try store.save(reminder, commit: true)
let output = ["sourceId": reminder.calendarItemIdentifier]
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
      deadline: item.dueDate,
      priority: mapPriority(item.priority, item.listName),
      energy: "medium",
      context: item.notes,
      quadrant: item.quadrant ?? mapQuadrant(item.listName)
    });
  }
  const completed = repo.markExternalTasksStatus("apple-reminders", completedSourceIds, "done");
  const deleted = repo.deleteExternalTasksBySourceIds("apple-reminders", deletedSourceIds) + repo.deleteTasksMissingFromSource("apple-reminders", knownSourceIds) + repo.deleteUnsourcedActiveTasks();

  return { listName, imported: activeSourceIds.length, completed, deleted, items: activeItems };
}

export function writeTaskToAppleReminder(task: Task): string | null {
  if (task.source !== "apple-reminders" || !task.sourceId) {
    return null;
  }
  const payload = {
    sourceId: task.sourceId,
    title: task.title,
    notes: task.context,
    deadline: task.deadline,
    priority: task.priority,
    status: task.status,
    quadrant: task.quadrant
  };
  const raw = execFileSync("swift", ["-e", EVENTKIT_WRITE_SCRIPT, JSON.stringify(payload)], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  const result = JSON.parse(raw.trim() || "{}") as { sourceId?: string };
  return result.sourceId ?? null;
}

function mapQuadrant(listName: string): Quadrant | null {
  const isNotImportant = listName.includes("唔重要") || listName.includes("不重要");
  const isImportant = listName.includes("重要") && !isNotImportant;
  const isNotUrgent = listName.includes("唔急") || listName.includes("不急") || listName.includes("唔緊急") || listName.includes("不緊急");
  const isUrgent = (listName.includes("緊急") || listName.includes("緊要")) && !isNotUrgent;
  if (isUrgent && isImportant) return "urgent-important";
  if (isUrgent && isNotImportant) return "urgent-not-important";
  if (isNotUrgent && isImportant) return "not-urgent-important";
  if (isNotUrgent && isNotImportant) return "not-urgent-not-important";
  return null;
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

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
  quickWin: boolean;
  statusTag: "pending" | "in_progress" | "done" | null;
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
let selectedCalendars = ensureManagedCalendars(store)
if selectedCalendars.isEmpty {
  throw NSError(domain: "PersonalAssistantReminders", code: 2, userInfo: [
    NSLocalizedDescriptionKey: "No managed reminder lists found. Available lists: " + names.joined(separator: ", ")
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
  let key = title
    .replacingOccurrences(of: " ", with: "")
    .replacingOccurrences(of: "　", with: "")
  let aliases: [String: String] = [
    "緊急重要": "urgent-important",
    "緊要重要": "urgent-important",
    "緊急不重要": "urgent-not-important",
    "緊急唔重要": "urgent-not-important",
    "緊要不重要": "urgent-not-important",
    "緊要唔重要": "urgent-not-important",
    "不緊急重要": "not-urgent-important",
    "重要不緊急": "not-urgent-important",
    "重要唔緊急": "not-urgent-important",
    "重要不急": "not-urgent-important",
    "唔緊急重要": "not-urgent-important",
    "不急重要": "not-urgent-important",
    "唔急重要": "not-urgent-important",
    "不緊急不重要": "not-urgent-not-important",
    "不緊急唔重要": "not-urgent-not-important",
    "唔緊急不重要": "not-urgent-not-important",
    "唔緊急唔重要": "not-urgent-not-important",
    "不急不重要": "not-urgent-not-important",
    "唔急唔重要": "not-urgent-not-important"
  ]
  return aliases[key]
}

func isPendingList(_ title: String) -> Bool {
  let key = title
    .replacingOccurrences(of: " ", with: "")
    .replacingOccurrences(of: "　", with: "")
  return key == "待定"
}

func isQuickWinList(_ title: String) -> Bool {
  let key = title
    .replacingOccurrences(of: " ", with: "")
    .replacingOccurrences(of: "　", with: "")
  return key == "2分鐘完成" || key == "兩分鐘完成" || key == "2分鐘" || key == "兩分鐘"
}

func ensureManagedCalendars(_ store: EKEventStore) -> [EKCalendar] {
  var calendars = store.calendars(for: .reminder)
  if !calendars.contains(where: { isPendingList($0.title) }) {
    let calendar = EKCalendar(for: .reminder, eventStore: store)
    calendar.title = "待定"
    calendar.source = store.defaultCalendarForNewReminders()?.source ?? store.sources.first
    try? store.saveCalendar(calendar, commit: true)
    calendars = store.calendars(for: .reminder)
  }
  if !calendars.contains(where: { isQuickWinList($0.title) }) {
    let calendar = EKCalendar(for: .reminder, eventStore: store)
    calendar.title = "2分鐘完成"
    calendar.source = store.defaultCalendarForNewReminders()?.source ?? store.sources.first
    try? store.saveCalendar(calendar, commit: true)
    calendars = store.calendars(for: .reminder)
  }
  return calendars.filter { quadrantKey($0.title) != nil || isPendingList($0.title) || isQuickWinList($0.title) }
}

let statusTags: [String: String] = ["#待定": "pending", "#進行中": "in_progress", "#完成": "done"]

func statusTag(_ text: String?) -> String? {
  guard let text else { return nil }
  for (tag, status) in statusTags {
    if text.contains(tag) { return status }
  }
  return nil
}

func cleanedNotes(_ text: String?) -> Any {
  guard var text else { return NSNull() }
  for tag in statusTags.keys {
    text = text.replacingOccurrences(of: tag, with: "")
  }
  let cleaned = text
    .components(separatedBy: .newlines)
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: "\\n")
  return cleaned.isEmpty ? NSNull() : cleaned
}

func reminderPayload(_ reminder: EKReminder) -> [String: Any] {
  return [
    "id": reminder.calendarItemIdentifier,
    "title": reminder.title ?? "",
    "notes": cleanedNotes(reminder.notes),
    "dueDate": isoDate(reminder.dueDateComponents) ?? NSNull(),
    "priority": reminder.priority,
    "completed": reminder.isCompleted,
    "listName": reminder.calendar.title,
    "quadrant": quadrantKey(reminder.calendar.title) ?? NSNull(),
    "quickWin": isQuickWinList(reminder.calendar.title),
    "statusTag": statusTag((reminder.notes ?? "") + " " + (reminder.title ?? "")) ?? NSNull()
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
  let key = title
    .replacingOccurrences(of: " ", with: "")
    .replacingOccurrences(of: "　", with: "")
  let aliases: [String: String] = [
    "緊急重要": "urgent-important",
    "緊要重要": "urgent-important",
    "緊急不重要": "urgent-not-important",
    "緊急唔重要": "urgent-not-important",
    "緊要不重要": "urgent-not-important",
    "緊要唔重要": "urgent-not-important",
    "不緊急重要": "not-urgent-important",
    "重要不緊急": "not-urgent-important",
    "重要唔緊急": "not-urgent-important",
    "重要不急": "not-urgent-important",
    "唔緊急重要": "not-urgent-important",
    "不急重要": "not-urgent-important",
    "唔急重要": "not-urgent-important",
    "不緊急不重要": "not-urgent-not-important",
    "不緊急唔重要": "not-urgent-not-important",
    "唔緊急不重要": "not-urgent-not-important",
    "唔緊急唔重要": "not-urgent-not-important",
    "不急不重要": "not-urgent-not-important",
    "唔急唔重要": "not-urgent-not-important"
  ]
  return aliases[key]
}

func isPendingList(_ title: String) -> Bool {
  let key = title
    .replacingOccurrences(of: " ", with: "")
    .replacingOccurrences(of: "　", with: "")
  return key == "待定"
}

func isQuickWinList(_ title: String) -> Bool {
  let key = title
    .replacingOccurrences(of: " ", with: "")
    .replacingOccurrences(of: "　", with: "")
  return key == "2分鐘完成" || key == "兩分鐘完成" || key == "2分鐘" || key == "兩分鐘"
}

func ensurePendingCalendar(_ store: EKEventStore) -> EKCalendar? {
  if let existing = store.calendars(for: .reminder).first(where: { isPendingList($0.title) }) {
    return existing
  }
  let calendar = EKCalendar(for: .reminder, eventStore: store)
  calendar.title = "待定"
  calendar.source = store.defaultCalendarForNewReminders()?.source ?? store.sources.first
  do {
    try store.saveCalendar(calendar, commit: true)
    return calendar
  } catch {
    return nil
  }
}

func ensureQuickWinCalendar(_ store: EKEventStore) -> EKCalendar? {
  if let existing = store.calendars(for: .reminder).first(where: { isQuickWinList($0.title) }) {
    return existing
  }
  let calendar = EKCalendar(for: .reminder, eventStore: store)
  calendar.title = "2分鐘完成"
  calendar.source = store.defaultCalendarForNewReminders()?.source ?? store.sources.first
  do {
    try store.saveCalendar(calendar, commit: true)
    return calendar
  } catch {
    return nil
  }
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

let managedStatusTags = ["#待定", "#進行中", "#完成"]

func statusLabel(_ status: String?) -> String? {
  switch status {
  case "in_progress":
    return "進行中"
  default:
    return nil
  }
}

func notesWithStatusTag(_ notes: String?, _ status: String?) -> String? {
  var cleaned = notes ?? ""
  for tag in managedStatusTags {
    cleaned = cleaned.replacingOccurrences(of: tag, with: "")
  }
  cleaned = cleaned
    .components(separatedBy: .newlines)
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: "\\n")
  guard let label = statusLabel(status) else {
    return cleaned.isEmpty ? nil : cleaned
  }
  return cleaned.isEmpty ? "#" + label : cleaned + "\\n#" + label
}

let sourceId = payload["sourceId"] as? String
let reminder: EKReminder
if let sourceId, let existing = store.calendarItem(withIdentifier: sourceId) as? EKReminder {
  reminder = existing
} else {
  reminder = EKReminder(eventStore: store)
}

let calendars = store.calendars(for: .reminder)
let quickWin = (payload["quickWin"] as? Bool) ?? false
if quickWin, let calendar = ensureQuickWinCalendar(store) {
  reminder.calendar = calendar
} else if let quadrant = payload["quadrant"] as? String,
   let calendar = calendars.first(where: { quadrantKey($0.title) == quadrant }) {
  reminder.calendar = calendar
} else if let calendar = ensurePendingCalendar(store) {
  reminder.calendar = calendar
} else if reminder.calendar == nil, let calendar = calendars.first(where: { quadrantKey($0.title) != nil }) ?? store.defaultCalendarForNewReminders() {
  reminder.calendar = calendar
}

reminder.title = (payload["title"] as? String) ?? reminder.title
reminder.notes = notesWithStatusTag(payload["notes"] as? String, payload["status"] as? String)
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

const EVENTKIT_DELETE_SCRIPT = `
import EventKit
import Foundation

let sourceId = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
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
  throw NSError(domain: "PersonalAssistantReminders", code: 20, userInfo: [
    NSLocalizedDescriptionKey: accessError?.localizedDescription ?? "Reminders delete access was not granted."
  ])
}

var deleted = false
if let reminder = store.calendarItem(withIdentifier: sourceId) as? EKReminder {
  try store.remove(reminder, commit: true)
  deleted = true
}

let data = try JSONSerialization.data(withJSONObject: ["deleted": deleted], options: [])
print(String(data: data, encoding: .utf8)!)
`;

export function syncAppleReminders(repo: AssistantRepository, listName = "全部"): SyncResult {
  const externalTasks = repo.listExternalTasks("apple-reminders");
  const externalTaskBySourceId = new Map(externalTasks.filter((task) => task.sourceId).map((task) => [task.sourceId!, task]));
  const trackedIds = externalTasks.map((task) => task.sourceId).filter((sourceId): sourceId is string => Boolean(sourceId));
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
    const quickWin = item.quickWin || isQuickWinList(item.listName);
    const existing = externalTaskBySourceId.get(item.id);
    const task = repo.upsertExternalTask({
      source: "apple-reminders",
      sourceId: item.id,
      title: item.title,
      durationMinutes: quickWin ? 2 : existing && existing.durationMinutes <= 2 ? 30 : undefined,
      deadline: item.dueDate,
      priority: mapPriority(item.priority, item.listName),
      energy: "medium",
      context: item.notes,
      quadrant: quickWin ? null : item.quadrant ?? mapQuadrant(item.listName)
    });
    if (item.statusTag !== statusTagForTask(task.status)) {
      const sourceId = writeTaskToAppleReminder(task);
      if (sourceId && sourceId !== task.sourceId) {
        repo.updateTask(task.id, { source: "apple-reminders", sourceId });
      }
    }
  }
  const completed = repo.markExternalTasksStatus("apple-reminders", completedSourceIds, "done");
  const deleted = repo.deleteExternalTasksBySourceIds("apple-reminders", deletedSourceIds) + repo.deleteTasksMissingFromSource("apple-reminders", knownSourceIds) + repo.deleteUnsourcedActiveTasks();

  return { listName, imported: activeSourceIds.length, completed, deleted, items: activeItems };
}

export function writeTaskToAppleReminder(task: Task): string | null {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return task.source === "apple-reminders" ? task.sourceId : null;
  }
  const payload = {
    sourceId: task.source === "apple-reminders" ? task.sourceId : null,
    title: task.title,
    notes: task.context,
    deadline: task.deadline,
    priority: task.priority,
    status: task.status,
    quickWin: task.durationMinutes <= 2,
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

export function deleteAppleReminderForTask(task: Task): boolean {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return false;
  }
  if (task.source !== "apple-reminders" || !task.sourceId) {
    return false;
  }
  const raw = execFileSync("swift", ["-e", EVENTKIT_DELETE_SCRIPT, task.sourceId], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  const result = JSON.parse(raw.trim() || "{}") as { deleted?: boolean };
  return Boolean(result.deleted);
}

function mapQuadrant(listName: string): Quadrant | null {
  const aliases: Record<string, Quadrant> = {
    緊急重要: "urgent-important",
    緊要重要: "urgent-important",
    緊急不重要: "urgent-not-important",
    緊急唔重要: "urgent-not-important",
    緊要不重要: "urgent-not-important",
    緊要唔重要: "urgent-not-important",
    不緊急重要: "not-urgent-important",
    重要不緊急: "not-urgent-important",
    重要唔緊急: "not-urgent-important",
    重要不急: "not-urgent-important",
    唔緊急重要: "not-urgent-important",
    不急重要: "not-urgent-important",
    唔急重要: "not-urgent-important",
    不緊急不重要: "not-urgent-not-important",
    不緊急唔重要: "not-urgent-not-important",
    唔緊急不重要: "not-urgent-not-important",
    唔緊急唔重要: "not-urgent-not-important",
    不急不重要: "not-urgent-not-important",
    唔急唔重要: "not-urgent-not-important"
  };
  return aliases[listName.replaceAll(/\s/g, "")] ?? null;
}

function isQuickWinList(listName: string): boolean {
  const key = listName.replaceAll(/\s/g, "");
  return key === "2分鐘完成" || key === "兩分鐘完成" || key === "2分鐘" || key === "兩分鐘";
}

function mapPriority(priority: number | null, listName = ""): number {
  const quadrant = mapQuadrant(listName);
  if (quadrant === "urgent-important" || quadrant === "not-urgent-important") {
    return 5;
  }
  if (quadrant === "urgent-not-important" || quadrant === "not-urgent-not-important") {
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

function statusTagForTask(status: Task["status"]): AppleReminderItem["statusTag"] {
  if (status === "in_progress") return "in_progress";
  return null;
}

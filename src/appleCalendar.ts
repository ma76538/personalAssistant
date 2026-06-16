import { execFileSync } from "node:child_process";

export type AppleCalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendarTitle: string;
  sourceTitle: string;
};

export type AppleCalendarResult = {
  accountEmail: string;
  connected: boolean;
  events: AppleCalendarEvent[];
  error?: string;
};

const EVENTKIT_CALENDAR_SCRIPT = `
import EventKit
import Foundation

let accountEmail = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "kevin@region.mo"
let startRaw = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let endRaw = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""
let store = EKEventStore()
let accessSemaphore = DispatchSemaphore(value: 0)
var granted = false
var accessError: Error?

if #available(macOS 14.0, *) {
  store.requestFullAccessToEvents { didGrant, error in
    granted = didGrant
    accessError = error
    accessSemaphore.signal()
  }
} else {
  store.requestAccess(to: .event) { didGrant, error in
    granted = didGrant
    accessError = error
    accessSemaphore.signal()
  }
}

accessSemaphore.wait()
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime]

func output(_ payload: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: payload, options: [])
  print(String(data: data, encoding: .utf8)!)
}

if !granted {
  output(["connected": false, "events": [], "error": accessError?.localizedDescription ?? "Calendar access was not granted."])
  exit(0)
}

guard let start = formatter.date(from: startRaw), let end = formatter.date(from: endRaw) else {
  output(["connected": false, "events": [], "error": "Invalid calendar date range."])
  exit(0)
}

let calendars = store.calendars(for: .event).filter { calendar in
  calendar.source.title.localizedCaseInsensitiveContains(accountEmail)
    || calendar.title.localizedCaseInsensitiveContains(accountEmail)
}

if calendars.isEmpty {
  output(["connected": false, "events": [], "error": "No calendar found for " + accountEmail])
  exit(0)
}

let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
let events = store.events(matching: predicate)
  .sorted { $0.startDate < $1.startDate }
  .map { event -> [String: Any] in
    [
      "id": event.eventIdentifier ?? "",
      "title": event.title ?? "(No title)",
      "start": formatter.string(from: event.startDate),
      "end": formatter.string(from: event.endDate),
      "allDay": event.isAllDay,
      "calendarTitle": event.calendar.title,
      "sourceTitle": event.calendar.source.title
    ]
  }

output(["connected": true, "events": events])
`;

export function listAppleCalendarEvents(accountEmail: string, startIso: string, endIso: string): AppleCalendarResult {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return { accountEmail, connected: false, events: [], error: "Calendar disabled in tests." };
  }
  try {
    const raw = execFileSync("swift", ["-e", EVENTKIT_CALENDAR_SCRIPT, accountEmail, startIso, endIso], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    const result = JSON.parse(raw.trim() || "{\"connected\":false,\"events\":[]}") as Omit<AppleCalendarResult, "accountEmail">;
    return { accountEmail, connected: Boolean(result.connected), events: result.events ?? [], error: result.error };
  } catch (error) {
    return {
      accountEmail,
      connected: false,
      events: [],
      error: error instanceof Error ? error.message : "Calendar sync failed."
    };
  }
}

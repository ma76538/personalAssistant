import { syncAppleReminders } from "./appleReminders.js";
import { listAppleCalendarEvents } from "./appleCalendar.js";
import { AssistantRepository } from "./db.js";
import { buildSchedule } from "./scheduler.js";

type AutoSyncOptions = {
  enabled: boolean;
  intervalMinutes: number;
  listName: string;
  logger?: Pick<Console, "log" | "error">;
  sync?: typeof syncAppleReminders;
  schedule?: typeof buildSchedule;
};

export function createAppleReminderAutoSync(repo: AssistantRepository, options: AutoSyncOptions): () => Promise<void> {
  let inFlight = false;
  let lastAttemptAt = 0;
  const logger = options.logger ?? console;
  const intervalMs = Math.max(1, options.intervalMinutes) * 60_000;
  const sync = options.sync ?? syncAppleReminders;
  const schedule = options.schedule ?? buildSchedule;

  return async () => {
    if (!options.enabled) {
      return;
    }
    if (inFlight) {
      logger.log("Apple Reminders auto-sync skipped: previous sync still running.");
      return;
    }
    const now = Date.now();
    if (lastAttemptAt && now - lastAttemptAt < intervalMs) {
      return;
    }
    lastAttemptAt = now;
    inFlight = true;
    try {
      const startedAt = new Date();
      const result = sync(repo, options.listName);
      repo.applySchedule(schedule(repo.listActiveTasks(), startedAt, calendarBusyBlocks(startedAt)));
      logger.log(
        `Apple Reminders auto-sync completed: imported ${result.imported}, completed ${result.completed}, deleted ${result.deleted}.`
      );
    } catch (error) {
      logger.error("Apple Reminders auto-sync failed", error);
    } finally {
      inFlight = false;
    }
  };
}

function calendarBusyBlocks(now: Date): Array<{ start: string; end: string; title?: string }> {
  const end = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const calendar = listAppleCalendarEvents(process.env.CALENDAR_ACCOUNT_EMAIL || "kevin@region.mo", now.toISOString(), end.toISOString());
  return calendar.events.map((event) => ({ start: event.start, end: event.end, title: event.title }));
}

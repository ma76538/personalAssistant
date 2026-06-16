import { syncAppleReminders } from "./appleReminders.js";
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
      const result = sync(repo, options.listName);
      repo.applySchedule(schedule(repo.listActiveTasks()));
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

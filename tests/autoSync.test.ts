import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAppleReminderAutoSync } from "../src/autoSync.js";
import { AssistantRepository } from "../src/db.js";

function tempRepo(): AssistantRepository {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-autosync-"));
  return new AssistantRepository(path.join(dir, "test.sqlite"));
}

describe("Apple Reminders auto-sync", () => {
  it("syncs once, reschedules, and skips repeated ticks within the interval", async () => {
    const repo = tempRepo();
    repo.addTask({ title: "緊急重要", quadrant: "urgent-important" });
    const sync = vi.fn(() => ({ listName: "全部", imported: 1, completed: 0, deleted: 0, items: [] }));
    const schedule = vi.fn(() => []);
    const logger = { log: vi.fn(), error: vi.fn() };
    const tick = createAppleReminderAutoSync(repo, {
      enabled: true,
      intervalMinutes: 5,
      listName: "全部",
      logger,
      sync,
      schedule
    });

    await tick();
    await tick();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(repo, "全部");
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    repo.close();
  });

  it("does nothing when disabled", async () => {
    const repo = tempRepo();
    const sync = vi.fn(() => ({ listName: "全部", imported: 0, completed: 0, deleted: 0, items: [] }));
    const tick = createAppleReminderAutoSync(repo, {
      enabled: false,
      intervalMinutes: 5,
      listName: "全部",
      sync
    });

    await tick();

    expect(sync).not.toHaveBeenCalled();
    repo.close();
  });
});

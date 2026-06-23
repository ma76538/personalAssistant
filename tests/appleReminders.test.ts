import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncAppleReminders } from "../src/appleReminders.js";
import { AssistantRepository } from "../src/db.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn()
}));

function tempRepo(): AssistantRepository {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-apple-reminders-"));
  return new AssistantRepository(path.join(dir, "test.sqlite"));
}

function mockSnapshot(snapshot: unknown) {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify(snapshot));
}

describe("Apple Reminders sync", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("imports Reminders quick-win list items as 2-minute tasks", () => {
    const repo = tempRepo();
    mockSnapshot({
      active: [
        {
          id: "quick-1",
          title: "影相俾 Nicole",
          notes: null,
          dueDate: null,
          priority: null,
          completed: false,
          listName: "2分鐘完成",
          quadrant: null,
          quickWin: true,
          statusTag: null
        }
      ],
      tracked: []
    });

    syncAppleReminders(repo);

    const [task] = repo.listAllTasks();
    expect(task.title).toBe("影相俾 Nicole");
    expect(task.durationMinutes).toBe(2);
    expect(task.quadrant).toBeNull();
    repo.close();
  });

  it("moves an existing synced task from a quadrant into quick wins", () => {
    const repo = tempRepo();
    repo.upsertExternalTask({
      source: "apple-reminders",
      sourceId: "reminder-1",
      title: "舊四象限任務",
      durationMinutes: 45,
      quadrant: "urgent-important"
    });
    mockSnapshot({
      active: [
        {
          id: "reminder-1",
          title: "改做兩分鐘",
          notes: null,
          dueDate: null,
          priority: null,
          completed: false,
          listName: "兩分鐘完成",
          quadrant: null,
          quickWin: true,
          statusTag: "pending"
        }
      ],
      tracked: [{ id: "reminder-1", completed: false, exists: true }]
    });

    syncAppleReminders(repo);

    const [task] = repo.listAllTasks();
    expect(task.title).toBe("改做兩分鐘");
    expect(task.durationMinutes).toBe(2);
    expect(task.quadrant).toBeNull();
    repo.close();
  });

  it("recognizes the user's important-not-urgent Reminders list name", () => {
    const repo = tempRepo();
    mockSnapshot({
      active: [
        {
          id: "important-later-1",
          title: "長期重要事項",
          notes: null,
          dueDate: null,
          priority: null,
          completed: false,
          listName: "重要不緊急",
          quadrant: null,
          quickWin: false,
          statusTag: "pending"
        }
      ],
      tracked: []
    });

    syncAppleReminders(repo);

    const [task] = repo.listAllTasks();
    expect(task.quadrant).toBe("not-urgent-important");
    expect(task.durationMinutes).toBe(30);
    repo.close();
  });
});

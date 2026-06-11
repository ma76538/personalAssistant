import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssistantRepository } from "../src/db.js";
import { runDailyBriefTick } from "../src/dailyBrief.js";
import { prioritizeTasks } from "../src/prioritizer.js";

function tempRepo(): AssistantRepository {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-brief-"));
  return new AssistantRepository(path.join(dir, "test.sqlite"));
}

describe("daily brief", () => {
  it("sends only once per day after the configured time", async () => {
    const repo = tempRepo();
    repo.addTask({ title: "今日重點", deadline: "2026-05-24T12:00:00.000Z" });
    const sent: string[] = [];

    await runDailyBriefTick(
      repo,
      1,
      async (_chatId, message) => {
        sent.push(message);
      },
      "08:30",
      new Date("2026-05-24T09:00:00.000Z")
    );
    await runDailyBriefTick(
      repo,
      1,
      async (_chatId, message) => {
        sent.push(message);
      },
      "08:30",
      new Date("2026-05-24T10:00:00.000Z")
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("今日工作重點");
    repo.close();
  });

  it("prioritizes urgent deadlines", () => {
    const repo = tempRepo();
    const later = repo.addTask({ title: "普通任務", priority: 3 });
    const urgent = repo.addTask({ title: "快到期任務", priority: 3, deadline: "2026-05-24T12:00:00.000Z" });
    const prioritized = prioritizeTasks([later, urgent], new Date("2026-05-24T09:00:00.000Z"));

    expect(prioritized[0].title).toBe("快到期任務");
    repo.close();
  });

  it("classifies Eisenhower quadrants", () => {
    const repo = tempRepo();
    const urgentImportant = repo.addTask({ title: "緊急重要", priority: 5, deadline: "2026-05-24T12:00:00.000Z" });
    const urgentNotImportant = repo.addTask({ title: "緊急不重要", priority: 2, deadline: "2026-05-24T12:00:00.000Z" });
    const notUrgentImportant = repo.addTask({ title: "不緊急重要", priority: 5, deadline: "2026-06-24T12:00:00.000Z" });
    const notUrgentNotImportant = repo.addTask({ title: "不緊急不重要", priority: 2 });

    const byTitle = new Map(
      prioritizeTasks([urgentImportant, urgentNotImportant, notUrgentImportant, notUrgentNotImportant], new Date("2026-05-24T09:00:00.000Z")).map(
        (task) => [task.title, task.quadrant]
      )
    );

    expect(byTitle.get("緊急重要")).toBe("urgent-important");
    expect(byTitle.get("緊急不重要")).toBe("urgent-not-important");
    expect(byTitle.get("不緊急重要")).toBe("not-urgent-important");
    expect(byTitle.get("不緊急不重要")).toBe("not-urgent-not-important");
    repo.close();
  });

  it("keeps a synced reminder in its source quadrant", () => {
    const repo = tempRepo();
    const task = repo.addTask({
      title: "Reminders 清單指定不緊急重要",
      priority: 5,
      deadline: "2026-05-24T12:00:00.000Z",
      quadrant: "not-urgent-important"
    });

    const [prioritized] = prioritizeTasks([task], new Date("2026-05-24T09:00:00.000Z"));

    expect(prioritized.quadrant).toBe("not-urgent-important");
    expect(prioritized.isUrgent).toBe(false);
    expect(prioritized.isImportant).toBe(true);
    repo.close();
  });
});

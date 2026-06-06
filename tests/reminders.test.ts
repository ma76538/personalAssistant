import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssistantRepository } from "../src/db.js";
import { runReminderTick } from "../src/reminders.js";

function tempRepo(): AssistantRepository {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-mvp-"));
  return new AssistantRepository(path.join(dir, "test.sqlite"));
}

describe("runReminderTick", () => {
  it("does not send the same reminder stage twice", async () => {
    const repo = tempRepo();
    const task = repo.addTask({ title: "開會", durationMinutes: 30 });
    repo.applySchedule([
      {
        taskId: task.id,
        scheduledStart: "2026-05-23T02:00:00.000Z",
        scheduledEnd: "2026-05-23T02:30:00.000Z"
      }
    ]);
    const sent: string[] = [];
    const now = new Date("2026-05-23T02:00:00.000Z");

    await runReminderTick(repo, 1, async (_chatId, message) => {
      sent.push(message);
    }, now);
    await runReminderTick(repo, 1, async (_chatId, message) => {
      sent.push(message);
    }, now);

    expect(sent).toHaveLength(3);
    expect(sent.some((message) => message.includes("30 分鐘後開始"))).toBe(true);
    expect(sent.some((message) => message.includes("10 分鐘後開始"))).toBe(true);
    expect(sent.some((message) => message.includes("現在開始"))).toBe(true);
    repo.close();
  });

  it("uses the configurable reminder policy", async () => {
    const repo = tempRepo();
    repo.saveReminderPolicy({
      intensity: "aggressive",
      beforeStart: { enabled: true, minutes: [30, 10] },
      start: { enabled: false, requireResponse: false },
      inProgress: { enabled: false, intervalMinutes: 30, minimumTaskMinutes: 30 },
      end: { enabled: true },
      unanswered: { enabled: false, minutes: [10, 25, 55] },
      quietHours: { enabled: false, start: "23:30", end: "08:00" },
      highPriority: { enabled: true, threshold: 4, extraBeforeStartMinutes: [60] }
    });
    const task = repo.addTask({ title: "高優先任務", durationMinutes: 60, priority: 5 });
    repo.applySchedule([
      {
        taskId: task.id,
        scheduledStart: "2026-05-23T10:00:00.000Z",
        scheduledEnd: "2026-05-23T11:00:00.000Z"
      }
    ]);
    const sent: string[] = [];

    await runReminderTick(repo, 1, async (_chatId, message) => {
      sent.push(message);
    }, new Date("2026-05-23T09:00:00.000Z"));
    await runReminderTick(repo, 1, async (_chatId, message) => {
      sent.push(message);
    }, new Date("2026-05-23T10:00:00.000Z"));

    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain("60 分鐘後開始");
    expect(sent.some((message) => message.includes("現在開始"))).toBe(false);
    repo.close();
  });

  it("suppresses reminder chasing during quiet hours", async () => {
    const repo = tempRepo();
    const task = repo.addTask({ title: "夜間任務", durationMinutes: 60 });
    repo.applySchedule([
      {
        taskId: task.id,
        scheduledStart: "2026-05-23T23:40:00.000Z",
        scheduledEnd: "2026-05-24T00:40:00.000Z"
      }
    ]);
    const sent: string[] = [];

    await runReminderTick(repo, 1, async (_chatId, message) => {
      sent.push(message);
    }, new Date("2026-05-23T23:40:00.000Z"));

    expect(sent).toHaveLength(0);
    repo.close();
  });
});

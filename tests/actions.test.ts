import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPendingAction, createPendingAction } from "../src/actions.js";
import { AssistantRepository } from "../src/db.js";

function tempRepo(): AssistantRepository {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-mvp-"));
  return new AssistantRepository(path.join(dir, "test.sqlite"));
}

describe("pending actions", () => {
  it("does not write add actions until confirmed", () => {
    const repo = tempRepo();
    const pending = createPendingAction(repo, {
      intent: "add",
      task: { title: "完成報價單", durationMinutes: 120, energy: "high" },
      confidence: 1
    });

    expect(repo.listActiveTasks()).toHaveLength(0);
    applyPendingAction(repo, pending);
    expect(repo.listActiveTasks()).toHaveLength(1);
    repo.close();
  });

  it("adds multiple tasks from one pending action", () => {
    const repo = tempRepo();
    const pending = createPendingAction(repo, {
      intent: "add",
      tasks: [{ title: "出 Invoice" }, { title: "寫論文", deadline: "2026-06-30T10:00:00.000Z" }],
      confidence: 1
    });

    expect(repo.listActiveTasks()).toHaveLength(0);
    applyPendingAction(repo, pending);
    expect(repo.listActiveTasks().map((task) => task.title)).toEqual(expect.arrayContaining(["出 Invoice", "寫論文"]));
    repo.close();
  });

  it("marks completion only after applying pending action", () => {
    const repo = tempRepo();
    const task = repo.addTask({ title: "整理文件" });
    const pending = createPendingAction(repo, {
      intent: "complete",
      task: { target: String(task.id) },
      confidence: 1
    });

    expect(repo.getTask(task.id)?.status).toBe("pending");
    applyPendingAction(repo, pending);
    expect(repo.getTask(task.id)?.status).toBe("done");
    repo.close();
  });

  it("clears stale schedules when a task no longer fits", () => {
    const repo = tempRepo();
    const task = repo.addTask({ title: "趕不上的任務", durationMinutes: 60 });
    repo.applySchedule([
      {
        taskId: task.id,
        scheduledStart: "2026-05-23T02:00:00.000Z",
        scheduledEnd: "2026-05-23T03:00:00.000Z"
      }
    ]);

    repo.applySchedule([]);

    expect(repo.getTask(task.id)?.scheduledStart).toBeNull();
    expect(repo.getTask(task.id)?.status).toBe("pending");
    repo.close();
  });

  it("upserts external todo items by source id", () => {
    const repo = tempRepo();
    const first = repo.upsertExternalTask({
      source: "apple-reminders",
      sourceId: "reminder-1",
      title: "舊標題"
    });
    const second = repo.upsertExternalTask({
      source: "apple-reminders",
      sourceId: "reminder-1",
      title: "新標題"
    });

    expect(first.id).toBe(second.id);
    expect(repo.listAllTasks()).toHaveLength(1);
    expect(repo.getTask(first.id)?.title).toBe("新標題");
    repo.close();
  });

  it("reconciles completed and deleted external todo items", () => {
    const repo = tempRepo();
    const active = repo.upsertExternalTask({
      source: "apple-reminders",
      sourceId: "active-reminder",
      title: "仍在 Reminder"
    });
    const completed = repo.upsertExternalTask({
      source: "apple-reminders",
      sourceId: "completed-reminder",
      title: "已完成 Reminder"
    });
    const deleted = repo.upsertExternalTask({
      source: "apple-reminders",
      sourceId: "deleted-reminder",
      title: "已刪除 Reminder"
    });

    repo.markExternalTasksStatus("apple-reminders", ["completed-reminder"], "done");
    repo.deleteExternalTasksBySourceIds("apple-reminders", ["deleted-reminder"]);

    expect(repo.getTask(active.id)?.status).toBe("pending");
    expect(repo.getTask(completed.id)?.status).toBe("done");
    expect(repo.getTask(deleted.id)).toBeNull();
    repo.close();
  });

  it("deletes unsourced active tasks when reminders are the source of truth", () => {
    const repo = tempRepo();
    const local = repo.addTask({ title: "本地臨時任務" });
    const done = repo.addTask({ title: "本地已完成任務" });
    repo.updateTask(done.id, { status: "done" });

    const deleted = repo.deleteUnsourcedActiveTasks();

    expect(deleted).toBe(1);
    expect(repo.getTask(local.id)).toBeNull();
    expect(repo.getTask(done.id)?.status).toBe("done");
    repo.close();
  });
});

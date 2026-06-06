import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { AssistantRepository } from "../src/db.js";
import { startDashboardServer } from "../src/dashboard.js";

let cleanup: (() => void) | null = null;

function createHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-dashboard-"));
  const repo = new AssistantRepository(path.join(dir, "test.sqlite"));
  const server = startDashboardServer(repo, 0);
  const address = server.address() as AddressInfo;
  cleanup = () => {
    server.close();
    repo.close();
  };
  return { repo, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("dashboard API", () => {
  it("serves and updates reminder settings", async () => {
    const { repo, baseUrl } = createHarness();

    const getResponse = await fetch(`${baseUrl}/api/reminder-settings`);
    expect(getResponse.status).toBe(200);
    const current = (await getResponse.json()) as { policy: { intensity: string } };
    expect(current.policy.intensity).toBe("aggressive");

    const nextPolicy = {
      intensity: "standard",
      beforeStart: { enabled: true, minutes: [20, 5] },
      start: { enabled: true, requireResponse: true },
      inProgress: { enabled: true, intervalMinutes: 45, minimumTaskMinutes: 30 },
      end: { enabled: true },
      unanswered: { enabled: true, minutes: [10, 30] },
      quietHours: { enabled: true, start: "23:00", end: "08:30" },
      highPriority: { enabled: true, threshold: 4, extraBeforeStartMinutes: [60] }
    };

    const putResponse = await fetch(`${baseUrl}/api/reminder-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextPolicy)
    });
    expect(putResponse.status).toBe(200);
    expect(repo.getReminderPolicy().beforeStart.minutes).toEqual([20, 5]);

    const invalidResponse = await fetch(`${baseUrl}/api/reminder-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...nextPolicy, beforeStart: { enabled: true, minutes: [-1] } })
    });
    expect(invalidResponse.status).toBe(400);
  });

  it("creates, edits, and completes a task", async () => {
    const { repo, baseUrl } = createHarness();

    const createResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "後台新增任務",
        durationMinutes: 45,
        priority: 4,
        energy: "high",
        context: "dashboard test"
      })
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { task: { id: number; title: string } };
    expect(created.task.title).toBe("後台新增任務");

    const patchResponse = await fetch(`${baseUrl}/api/tasks/${created.task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "後台編輯任務", durationMinutes: 60, status: "pending" })
    });
    expect(patchResponse.status).toBe(200);
    expect(repo.getTask(created.task.id)?.title).toBe("後台編輯任務");
    expect(repo.getTask(created.task.id)?.durationMinutes).toBe(60);

    const doneResponse = await fetch(`${baseUrl}/api/tasks/${created.task.id}/done`, { method: "POST" });
    expect(doneResponse.status).toBe(200);
    expect(repo.getTask(created.task.id)?.status).toBe("done");
  });
});

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { AssistantRepository } from "../src/db.js";
import { DashboardServerOptions, startDashboardServer } from "../src/dashboard.js";

let cleanup: (() => void) | null = null;

function createHarness(options?: DashboardServerOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-dashboard-"));
  const repo = new AssistantRepository(path.join(dir, "test.sqlite"));
  const server = startDashboardServer(repo, 0, undefined, options);
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
  it("protects dashboard APIs with Google auth and lets admins manage users", async () => {
    const { repo, baseUrl } = createHarness({
      auth: {
        enabled: true,
        adminEmails: ["admin@example.com"],
        googleClientId: "client-id",
        googleClientSecret: "client-secret"
      }
    });

    const blockedResponse = await fetch(`${baseUrl}/api/summary`);
    expect(blockedResponse.status).toBe(401);

    const authUrlResponse = await fetch(`${baseUrl}/auth/google`, { redirect: "manual" });
    expect(authUrlResponse.status).toBe(302);
    expect(authUrlResponse.headers.get("location")).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authUrlResponse.headers.get("set-cookie")).toContain("pa_oauth_state");

    const admin = repo.getDashboardUserByEmail("admin@example.com")!;
    const token = "test-session-token";
    repo.createDashboardSession({
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: admin.id,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    });
    const cookie = { Cookie: `pa_session=${encodeURIComponent(token)}` };

    const meResponse = await fetch(`${baseUrl}/api/me`, { headers: cookie });
    expect(meResponse.status).toBe(200);
    const me = (await meResponse.json()) as { user: { email: string; role: string } };
    expect(me.user.email).toBe("admin@example.com");
    expect(me.user.role).toBe("admin");

    const createUserResponse = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { ...cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", role: "user", status: "active" })
    });
    expect(createUserResponse.status).toBe(201);
    expect(repo.getDashboardUserByEmail("user@example.com")?.status).toBe("active");

    const created = (await createUserResponse.json()) as { user: { id: number } };
    const disableResponse = await fetch(`${baseUrl}/api/admin/users/${created.user.id}`, {
      method: "PATCH",
      headers: { ...cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "disabled" })
    });
    expect(disableResponse.status).toBe(200);
    expect(repo.getDashboardUserByEmail("user@example.com")?.status).toBe("disabled");
  });

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

  it("serves and updates calendar settings", async () => {
    const { repo, baseUrl } = createHarness();

    const getResponse = await fetch(`${baseUrl}/api/calendar-settings`);
    expect(getResponse.status).toBe(200);
    const current = (await getResponse.json()) as { accountEmail: string; provider: string; oauthStatus: string; hasGoogleClientSecret: boolean; redirectUri: string };
    expect(current.accountEmail).toBe("kevin@region.mo");
    expect(current.provider).toBe("google-calendar");
    expect(current.oauthStatus).toBe("google_credentials_missing");
    expect(current.hasGoogleClientSecret).toBe(false);

    const putResponse = await fetch(`${baseUrl}/api/calendar-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountEmail: "calendar@example.com", googleClientId: "client-id", googleClientSecret: "client-secret" })
    });
    expect(putResponse.status).toBe(200);
    expect(repo.getSetting("calendar_account_email")).toBe("calendar@example.com");
    expect(repo.getSetting("google_calendar_client_id")).toBe("client-id");
    expect(repo.getSetting("google_calendar_client_secret")).toBe("client-secret");

    const authResponse = await fetch(`${baseUrl}/api/calendar-settings/google-auth-url`, { method: "POST" });
    expect(authResponse.status).toBe(200);
    const auth = (await authResponse.json()) as { authUrl: string; redirectUri: string };
    expect(auth.authUrl).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(auth.authUrl).toContain("calendar.readonly");
    expect(auth.redirectUri).toContain("/oauth/google-calendar/callback");

    const invalidResponse = await fetch(`${baseUrl}/api/calendar-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountEmail: "not-an-email" })
    });
    expect(invalidResponse.status).toBe(400);

    const openPrivacyResponse = await fetch(`${baseUrl}/api/calendar-settings/open-privacy`, { method: "POST" });
    expect(openPrivacyResponse.status).toBe(404);
  });

  it("serves work capacity settings and replans after updates", async () => {
    const { repo, baseUrl } = createHarness();
    repo.addTask({
      title: "容量測試",
      durationMinutes: 90,
      deadline: "2026-06-25T10:00:00.000Z",
      quadrant: "urgent-important",
      deadlineType: "hard",
      valueScore: 5
    });

    const getResponse = await fetch(`${baseUrl}/api/work-capacity`);
    expect(getResponse.status).toBe(200);
    const current = (await getResponse.json()) as { dailyWorkCapacityHours: number; secretaryMvpMode: boolean };
    expect(current.dailyWorkCapacityHours).toBe(3);
    expect(current.secretaryMvpMode).toBe(true);

    const putResponse = await fetch(`${baseUrl}/api/work-capacity`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dailyWorkCapacityHours: 1.5, secretaryMvpMode: false })
    });
    expect(putResponse.status).toBe(200);
    expect(repo.getWorkSettings().dailyWorkCapacityHours).toBe(1.5);
    expect(repo.listAllTasks()[0].scheduledStart).not.toBeNull();

    const invalidResponse = await fetch(`${baseUrl}/api/work-capacity`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dailyWorkCapacityHours: 0, secretaryMvpMode: true })
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
        context: "dashboard test",
        valueScore: 5,
        deadlineType: "soft",
        isProject: true,
        progressNote: "先建立目標"
      })
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { task: { id: number; title: string; valueScore: number } };
    expect(created.task.title).toBe("後台新增任務");
    expect(created.task.valueScore).toBe(5);

    const patchResponse = await fetch(`${baseUrl}/api/tasks/${created.task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "後台編輯任務", durationMinutes: 60, status: "pending" })
    });
    expect(patchResponse.status).toBe(200);
    expect(repo.getTask(created.task.id)?.title).toBe("後台編輯任務");
    expect(repo.getTask(created.task.id)?.durationMinutes).toBe(60);

    const statusOnlyResponse = await fetch(`${baseUrl}/api/tasks/${created.task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" })
    });
    expect(statusOnlyResponse.status).toBe(200);
    expect(repo.getTask(created.task.id)?.status).toBe("in_progress");
    expect(repo.getTask(created.task.id)?.title).toBe("後台編輯任務");
    expect(repo.getTask(created.task.id)?.durationMinutes).toBe(60);
    expect(repo.getTask(created.task.id)?.priority).toBe(4);

    const doneResponse = await fetch(`${baseUrl}/api/tasks/${created.task.id}/done`, { method: "POST" });
    expect(doneResponse.status).toBe(200);
    expect(repo.getTask(created.task.id)?.status).toBe("done");

    const summaryResponse = await fetch(`${baseUrl}/api/summary`);
    expect(summaryResponse.status).toBe(200);
    const summary = (await summaryResponse.json()) as { completed: Array<{ id: number; title: string }> };
    expect(summary.completed.some((task) => task.id === created.task.id)).toBe(true);

    const deleteResponse = await fetch(`${baseUrl}/api/tasks/${created.task.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
    expect(repo.getTask(created.task.id)).toBeNull();
  });

  it("supports pending review, check-in, and next action preview", async () => {
    const { repo, baseUrl } = createHarness();
    const pending = repo.addTask({ title: "Siri 快速記低", durationMinutes: 120 });
    const project = repo.addTask({
      title: "電子秘書 MVP",
      durationMinutes: 600,
      deadline: "2026-06-30T10:00:00.000Z",
      deadlineType: "hard",
      valueScore: 5,
      isProject: true,
      quadrant: "urgent-important"
    });

    const reviewResponse = await fetch(`${baseUrl}/api/pending-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 5 })
    });
    const review = (await reviewResponse.json()) as { items: Array<{ task: { id: number }; suggestion: { isProject: boolean; clarificationQuestions: string[] } }> };
    expect(reviewResponse.status).toBe(200);
    expect(review.items.some((item) => item.task.id === pending.id)).toBe(true);
    expect(review.items[0].suggestion.clarificationQuestions.length).toBeGreaterThan(0);

    const nextResponse = await fetch(`${baseUrl}/api/projects/${project.id}/next-action-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progressNote: "已完成同步" })
    });
    const next = (await nextResponse.json()) as { action: { title: string; durationMinutes: number } };
    expect(nextResponse.status).toBe(200);
    expect(next.action.title).toContain("電子秘書 MVP");
    expect(next.action.durationMinutes).toBe(60);

    const triageResponse = await fetch(`${baseUrl}/api/tasks/${project.id}/triage-preview`, { method: "POST" });
    const triage = (await triageResponse.json()) as { suggestion: { valueScore: number; recommendedQuadrant: string | null } };
    expect(triageResponse.status).toBe(200);
    expect(triage.suggestion.valueScore).toBe(5);
    expect(triage.suggestion.recommendedQuadrant).toBe("not-urgent-important");

    const checkInResponse = await fetch(`${baseUrl}/api/tasks/${project.id}/check-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "stuck", note: "Calendar 權限未開" })
    });
    expect(checkInResponse.status).toBe(200);
    expect(repo.getTask(project.id)?.status).toBe("in_progress");
    expect(repo.getTask(project.id)?.progressNote).toContain("Calendar 權限未開");
  });

  it("supports optional subtasks without auto-decomposing tasks", async () => {
    const { repo, baseUrl } = createHarness();
    const project = repo.addTask({
      title: "準備社工局項目俾阿成",
      durationMinutes: 120,
      quadrant: "urgent-important",
      valueScore: 5,
      isProject: true
    });

    const previewResponse = await fetch(`${baseUrl}/api/tasks/${project.id}/subtasks/decompose-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "只要 preview，不要自動寫入" })
    });
    const preview = (await previewResponse.json()) as { decomposition: { requiresSubtasks: boolean; subtasks: Array<{ title: string }> } };
    expect(previewResponse.status).toBe(200);
    expect(preview.decomposition.requiresSubtasks).toBe(true);
    expect(preview.decomposition.subtasks.length).toBeGreaterThan(0);
    expect(repo.listSubtasks(project.id)).toHaveLength(0);

    const addResponse = await fetch(`${baseUrl}/api/tasks/${project.id}/subtasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "確認完成標準" })
    });
    const added = (await addResponse.json()) as { subtask: { id: number } };
    expect(addResponse.status).toBe(201);
    expect(repo.subtaskSummary(project.id).total).toBe(1);

    const tasksResponse = await fetch(`${baseUrl}/api/tasks`);
    const tasksPayload = (await tasksResponse.json()) as { tasks: Array<{ id: number; subtaskSummary: { total: number; pending: number; next: { title: string } | null } }> };
    const taskPayload = tasksPayload.tasks.find((task) => task.id === project.id);
    expect(taskPayload?.subtaskSummary.total).toBe(1);
    expect(taskPayload?.subtaskSummary.next?.title).toBe("確認完成標準");

    const checkboxResponse = await fetch(`${baseUrl}/api/subtasks/${added.subtask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });
    expect(checkboxResponse.status).toBe(200);
    expect(repo.subtaskSummary(project.id).done).toBe(1);
    expect(repo.getTask(project.id)?.status).not.toBe("done");

    const secondAddResponse = await fetch(`${baseUrl}/api/tasks/${project.id}/subtasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "提交給阿成" })
    });
    const secondAdded = (await secondAddResponse.json()) as { subtask: { id: number } };
    const reorderResponse = await fetch(`${baseUrl}/api/subtasks/${secondAdded.subtask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sortOrder: 0 })
    });
    expect(reorderResponse.status).toBe(200);
    expect(repo.listSubtasks(project.id)[0].id).toBe(secondAdded.subtask.id);

    const completeNextResponse = await fetch(`${baseUrl}/api/tasks/${project.id}/subtasks/complete-next`, { method: "POST" });
    expect(completeNextResponse.status).toBe(200);
    expect(repo.subtaskSummary(project.id).done).toBe(2);
    expect(repo.getTask(project.id)?.status).not.toBe("done");

    const deleteResponse = await fetch(`${baseUrl}/api/subtasks/${secondAdded.subtask.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
    expect(repo.subtaskSummary(project.id).total).toBe(1);
  });

  it("clears completed tasks", async () => {
    const { repo, baseUrl } = createHarness();
    const done = repo.addTask({ title: "已完成任務" });
    const active = repo.addTask({ title: "未完成任務" });
    repo.updateTask(done.id, { status: "done" });

    const response = await fetch(`${baseUrl}/api/tasks/completed`, { method: "DELETE" });
    const payload = (await response.json()) as { deleted: number };

    expect(response.status).toBe(200);
    expect(payload.deleted).toBe(1);
    expect(repo.getTask(done.id)).toBeNull();
    expect(repo.getTask(active.id)?.title).toBe("未完成任務");
  });

  it("returns monthly calendar data for the dashboard", async () => {
    const { repo, baseUrl } = createHarness();
    repo.addTask({ title: "本月任務", quadrant: "urgent-important", deadline: "2026-06-20T10:00:00.000Z" });
    const dueOnly = repo.addTask({ title: "按期限入月曆", quadrant: "urgent-important", deadline: "2026-06-25T10:00:00.000Z" });
    repo.updateTask(dueOnly.id, { scheduledStart: "2026-07-01T10:00:00.000Z", scheduledEnd: "2026-07-01T10:30:00.000Z" });
    repo.addTask({ title: "待補日期", quadrant: "not-urgent-important" });
    repo.addTask({ title: "持續推進項目", quadrant: "not-urgent-important", isProject: true, nextReviewAt: "2026-06-24T10:00:00.000Z" });
    repo.addTask({ title: "緊急長項目仍要 Due", quadrant: "urgent-important", isProject: true, nextReviewAt: "2026-06-24T10:00:00.000Z" });
    const notUrgentImportant = repo.addTask({ title: "不緊急重要不入甘特圖", quadrant: "not-urgent-important", deadline: "2026-06-26T10:00:00.000Z" });
    repo.addTask({ title: "純待定任務" });
    const quickWin = repo.addTask({ title: "兩分鐘任務", durationMinutes: 2, quadrant: "urgent-important", deadline: "2026-06-20T10:00:00.000Z" });
    const lowValue = repo.addTask({ title: "不緊急不重要任務", quadrant: "not-urgent-not-important", deadline: "2026-06-20T10:00:00.000Z" });

    const response = await fetch(`${baseUrl}/api/summary`);
    const payload = (await response.json()) as {
      month: Array<{ title: string; deadline: string | null; scheduledStart: string | null }>;
      calendar: { accountEmail: string; provider: string; connected: boolean; events: unknown[] };
      pendingBucket: Array<{ title: string }>;
      missingDeadlines: Array<{ title: string }>;
      scheduleSegments: Array<{ taskId: number }>;
    };

    expect(response.status).toBe(200);
    expect(Array.isArray(payload.month)).toBe(true);
    expect(payload.month.map((task) => task.title)).toContain("按期限入月曆");
    expect(payload.month.find((task) => task.title === "按期限入月曆")?.deadline).toBe("2026-06-25T10:00:00.000Z");
    expect(payload.calendar.accountEmail).toBe("kevin@region.mo");
    expect(payload.calendar.provider).toBe("google-calendar");
    expect(payload.calendar.connected).toBe(false);
    expect(payload.calendar.events).toEqual([]);
    expect(payload.pendingBucket.map((task) => task.title)).toContain("純待定任務");
    expect(payload.missingDeadlines.map((task) => task.title)).toContain("待補日期");
    expect(payload.missingDeadlines.map((task) => task.title)).toContain("緊急長項目仍要 Due");
    expect(payload.missingDeadlines.map((task) => task.title)).not.toContain("持續推進項目");
    expect(payload.missingDeadlines.map((task) => task.title)).not.toContain("純待定任務");
    expect(payload.scheduleSegments.length).toBeGreaterThan(0);
    expect(payload.scheduleSegments.map((segment) => segment.taskId)).not.toContain(quickWin.id);
    expect(payload.scheduleSegments.map((segment) => segment.taskId)).not.toContain(lowValue.id);
    expect(payload.scheduleSegments.map((segment) => segment.taskId)).not.toContain(notUrgentImportant.id);
  });

  it("uses only manually selected tasks for today focus", async () => {
    const { repo, baseUrl } = createHarness();
    const automatic = repo.addTask({ title: "高分但未選", priority: 5, quadrant: "urgent-important", deadline: "2026-06-20T10:00:00.000Z" });
    const second = repo.addTask({ title: "第二件今日做", quadrant: "urgent-not-important", todayFocusOrder: 2 });
    const first = repo.addTask({ title: "第一件今日做", quadrant: "not-urgent-important", todayFocusOrder: 1 });
    const completed = repo.addTask({ title: "已完成今日項", quadrant: "urgent-important", todayFocusOrder: 3 });
    repo.updateTask(completed.id, { status: "done" });

    const initialResponse = await fetch(`${baseUrl}/api/summary`);
    const initial = (await initialResponse.json()) as { topPriorities: Array<{ title: string }> };

    expect(initial.topPriorities.map((task) => task.title)).toEqual(["第一件今日做", "第二件今日做"]);
    expect(initial.topPriorities.map((task) => task.title)).not.toContain("高分但未選");
    expect(initial.topPriorities.map((task) => task.title)).not.toContain("已完成今日項");

    await fetch(`${baseUrl}/api/tasks/${automatic.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ todayFocusOrder: 3 })
    });
    await fetch(`${baseUrl}/api/tasks/${first.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ todayFocusOrder: null })
    });

    const updatedResponse = await fetch(`${baseUrl}/api/summary`);
    const updated = (await updatedResponse.json()) as { topPriorities: Array<{ title: string }> };
    expect(updated.topPriorities.map((task) => task.title)).toEqual(["第二件今日做", "高分但未選"]);
    expect(repo.getTask(first.id)?.todayFocusOrder).toBeNull();
  });

  it("documents and renders the task container framework", async () => {
    const { baseUrl } = createHarness();

    const response = await fetch(baseUrl);
    const html = await response.text();
    const readme = fs.readFileSync(path.join(process.cwd(), "research", "README.md"), "utf8");
    const framework = fs.readFileSync(path.join(process.cwd(), "research", "task-container-framework.md"), "utf8");

    expect(response.status).toBe(200);
    expect(html).toContain("任務應放在哪裡？");
    expect(html).toContain("長項目 / Project");
    expect(html).toContain("Calendar 活動");
    expect(html).toContain("長項目 / 持續推進");
    expect(html).toContain("沒有真正 deadline、但要定期推進時使用。");
    expect(readme).toContain("./task-container-framework.md");
    expect(framework).toContain("郭正橦個人小型展覽");
    expect(framework).toContain("銀葵4個軟著");
    expect(framework).toContain("商會 AI 應用培訓");
    expect(framework).toContain("先判斷容器，再決定提醒和排程");
  });
});

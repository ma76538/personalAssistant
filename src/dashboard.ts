import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mime from "mime";
import { z } from "zod";
import { AssistantRepository } from "./db.js";
import { deleteAppleReminderForTask, syncAppleReminders, writeTaskToAppleReminder } from "./appleReminders.js";
import { buildSchedule, BusyBlock } from "./scheduler.js";
import { prioritizeTasks } from "./prioritizer.js";
import { endOfLocalDay, startOfLocalDay, startOfNextWeek } from "./time.js";
import {
  DeadlineTypeSchema,
  EnergySchema,
  NextActionSuggestion,
  QuadrantSchema,
  ReminderPolicySchema,
  SubtaskStatusSchema,
  Task,
  TaskSubtaskSummary,
  TaskStatusSchema,
  WorkSettingsSchema
} from "./types.js";
import { buildSubtaskDecomposition, buildTriageSuggestion, fallbackNextAction } from "./triage.js";
import { MiniMaxClient } from "./minimax.js";
import {
  calendarSettings,
  CalendarEvent,
  completeGoogleCalendarOAuth,
  createGoogleCalendarAuthUrl,
  listCalendarEvents,
  saveCalendarSettings
} from "./calendarProvider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

export function startDashboardServer(repo: AssistantRepository, port: number, minimax?: MiniMaxClient): http.Server {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    try {
      if (url.pathname === "/api/tasks" && request.method === "GET") {
        sendJson(response, { tasks: attachSubtaskSummaries(repo, repo.listAllTasks()) });
        return;
      }

      if (url.pathname === "/api/tasks" && request.method === "POST") {
        const input = TaskInputSchema.parse(await readJson(request));
        const task = repo.addTask(input);
        const sourceId = writeTaskToAppleReminder(task);
        if (sourceId) {
          repo.updateTask(task.id, { source: "apple-reminders", sourceId });
        }
        await reschedule(repo);
        sendJson(response, { task: repo.getTask(task.id) }, 201);
        return;
      }

      if (url.pathname === "/api/work-capacity" && request.method === "GET") {
        sendJson(response, repo.getWorkSettings());
        return;
      }

      if (url.pathname === "/api/work-capacity" && request.method === "PUT") {
        const settings = WorkSettingsSchema.parse(await readJson(request));
        const saved = repo.saveWorkSettings(settings);
        await reschedule(repo);
        sendJson(response, { ...saved, tasks: repo.listAllTasks() });
        return;
      }

      if (url.pathname === "/api/pending-review" && request.method === "POST") {
        const input = PendingReviewSchema.parse(await readJson(request));
        const settings = repo.getWorkSettings();
        const pending = repo
          .listAllTasks()
          .filter((task) => !["done", "cancelled"].includes(task.status) && !task.quadrant)
          .slice(0, input.limit);
        sendJson(response, {
          items: pending.map((task) => ({
            task,
            suggestion: buildTriageSuggestion(task, {
              now: new Date(),
              dailyWorkCapacityHours: settings.dailyWorkCapacityHours,
              secretaryMvpMode: settings.secretaryMvpMode
            })
          }))
        });
        return;
      }

      const taskSubtasksMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/subtasks$/);
      if (taskSubtasksMatch && request.method === "GET") {
        const taskId = Number(taskSubtasksMatch[1]);
        if (!repo.getTask(taskId)) {
          sendJson(response, { error: "Task not found" }, 404);
          return;
        }
        sendJson(response, { subtasks: repo.listSubtasks(taskId), summary: repo.subtaskSummary(taskId) });
        return;
      }

      if (taskSubtasksMatch && request.method === "POST") {
        const taskId = Number(taskSubtasksMatch[1]);
        const input = SubtaskInputSchema.parse(await readJson(request));
        const subtask = repo.addSubtask({ taskId, ...input });
        sendJson(response, { subtask, summary: repo.subtaskSummary(taskId) }, 201);
        return;
      }

      const decomposeMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/subtasks\/decompose-preview$/);
      if (decomposeMatch && request.method === "POST") {
        const taskId = Number(decomposeMatch[1]);
        const task = repo.getTask(taskId);
        if (!task) {
          sendJson(response, { error: "Task not found" }, 404);
          return;
        }
        const input = SubtaskDecomposeSchema.parse(await readJson(request));
        sendJson(response, { task, decomposition: await subtaskDecompositionPreview(task, input.note, minimax) });
        return;
      }

      const completeNextMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/subtasks\/complete-next$/);
      if (completeNextMatch && request.method === "POST") {
        const taskId = Number(completeNextMatch[1]);
        if (!repo.getTask(taskId)) {
          sendJson(response, { error: "Task not found" }, 404);
          return;
        }
        const subtask = repo.completeNextSubtask(taskId);
        sendJson(response, { subtask, summary: repo.subtaskSummary(taskId) });
        return;
      }

      const stuckNextMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/subtasks\/stuck-next$/);
      if (stuckNextMatch && request.method === "POST") {
        const taskId = Number(stuckNextMatch[1]);
        if (!repo.getTask(taskId)) {
          sendJson(response, { error: "Task not found" }, 404);
          return;
        }
        const input = SubtaskStuckSchema.parse(await readJson(request));
        const subtask = repo.markNextSubtaskBlocked(taskId, input.note);
        sendJson(response, { subtask, summary: repo.subtaskSummary(taskId) });
        return;
      }

      const subtaskMatch = url.pathname.match(/^\/api\/subtasks\/(\d+)$/);
      if (subtaskMatch && request.method === "PATCH") {
        const subtaskId = Number(subtaskMatch[1]);
        const current = repo.getSubtask(subtaskId);
        if (!current) {
          sendJson(response, { error: "Subtask not found" }, 404);
          return;
        }
        const input = SubtaskPatchSchema.parse(await readJson(request));
        const subtask = repo.updateSubtask(subtaskId, input);
        sendJson(response, { subtask, summary: repo.subtaskSummary(current.taskId) });
        return;
      }

      const checkInMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/check-in$/);
      if (checkInMatch && request.method === "POST") {
        const taskId = Number(checkInMatch[1]);
        const current = repo.getTask(taskId);
        if (!current) {
          sendJson(response, { error: "Task not found" }, 404);
          return;
        }
        const input = CheckInSchema.parse(await readJson(request));
        const updated = applyCheckIn(repo, current, input);
        writeTaskToAppleReminder(updated);
        await reschedule(repo);
        const project = updated.isProject ? updated : updated.projectId ? repo.getTask(updated.projectId) : null;
        const preview = project && input.outcome === "complete" ? await nextActionPreview(project, input.note, minimax) : null;
        sendJson(response, { task: repo.getTask(updated.id), nextActionPreview: preview });
        return;
      }

      const triageMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/triage-preview$/);
      if (triageMatch && request.method === "POST") {
        const taskId = Number(triageMatch[1]);
        const task = repo.getTask(taskId);
        if (!task) {
          sendJson(response, { error: "Task not found" }, 404);
          return;
        }
        const settings = repo.getWorkSettings();
        sendJson(response, { task, suggestion: await triagePreview(task, settings, minimax) });
        return;
      }

      const nextActionMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/next-action-preview$/);
      if (nextActionMatch && request.method === "POST") {
        const projectId = Number(nextActionMatch[1]);
        const project = repo.getTask(projectId);
        if (!project) {
          sendJson(response, { error: "Project not found" }, 404);
          return;
        }
        const input = NextActionPreviewSchema.parse(await readJson(request));
        sendJson(response, { project, action: await nextActionPreview(project, input.progressNote, minimax) });
        return;
      }

      if (url.pathname === "/api/tasks/completed" && request.method === "DELETE") {
        const deleted = repo.deleteTasksByStatus("done");
        await reschedule(repo);
        sendJson(response, { deleted });
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch && request.method === "PATCH") {
        const taskId = Number(taskMatch[1]);
        const current = repo.getTask(taskId);
        if (!current) {
          sendJson(response, { error: "Task not found" }, 404);
          return;
        }

        const input = TaskPatchSchema.parse(await readJson(request));
        const nextStatus = input.status ?? current.status;
        const shouldClearSchedule = ["pending", "scheduled", "done", "cancelled"].includes(nextStatus);
        const updated = repo.updateTask(taskId, {
          ...input,
          scheduledStart: shouldClearSchedule ? null : current.scheduledStart,
          scheduledEnd: shouldClearSchedule ? null : current.scheduledEnd
        });
        const sourceId = writeTaskToAppleReminder(updated);
        if (sourceId && sourceId !== updated.sourceId) {
          repo.updateTask(taskId, { source: "apple-reminders", sourceId });
        }
        await reschedule(repo);
        sendJson(response, { task: repo.getTask(taskId) });
        return;
      }

      if (taskMatch && request.method === "DELETE") {
        const taskId = Number(taskMatch[1]);
        const current = repo.getTask(taskId);
        if (!current) {
          sendJson(response, { error: "Task not found" }, 404);
          return;
        }
        deleteAppleReminderForTask(current);
        const deleted = repo.deleteTask(taskId);
        await reschedule(repo);
        sendJson(response, { deleted: true });
        return;
      }

      const actionMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/(done|cancel)$/);
      if (actionMatch && request.method === "POST") {
        const taskId = Number(actionMatch[1]);
        const status = actionMatch[2] === "done" ? "done" : "cancelled";
        const updated = repo.updateTask(taskId, { status, scheduledStart: null, scheduledEnd: null });
        writeTaskToAppleReminder(updated);
        await reschedule(repo);
        sendJson(response, { task: repo.getTask(taskId) });
        return;
      }

      if (url.pathname === "/api/replan" && request.method === "POST") {
        await reschedule(repo);
        sendJson(response, { tasks: repo.listAllTasks() });
        return;
      }

      if (url.pathname === "/api/sync/apple-reminders" && request.method === "POST") {
        const input = SyncInputSchema.parse(await readJson(request));
        const result = syncAppleReminders(repo, input.listName);
        await reschedule(repo);
        sendJson(response, { ...result, tasks: repo.listAllTasks() });
        return;
      }

      if (url.pathname === "/api/reminder-settings" && request.method === "GET") {
        sendJson(response, { policy: repo.getReminderPolicy() });
        return;
      }

      if (url.pathname === "/api/reminder-settings" && request.method === "PUT") {
        const policy = ReminderPolicySchema.parse(await readJson(request));
        sendJson(response, { policy: repo.saveReminderPolicy(policy) });
        return;
      }

      if (url.pathname === "/api/reminder-settings/reset" && request.method === "POST") {
        sendJson(response, { policy: repo.resetReminderPolicy() });
        return;
      }

      if (url.pathname === "/api/calendar-settings" && request.method === "GET") {
        sendJson(response, calendarSettings(repo, requestOrigin(request)));
        return;
      }

      if (url.pathname === "/api/calendar-settings" && request.method === "PUT") {
        const input = CalendarSettingsSchema.parse(await readJson(request));
        saveCalendarSettings(repo, input);
        sendJson(response, calendarSettings(repo, requestOrigin(request)));
        return;
      }

      if (url.pathname === "/api/calendar-settings/google-auth-url" && request.method === "POST") {
        sendJson(response, {
          authUrl: createGoogleCalendarAuthUrl(repo, requestOrigin(request)),
          redirectUri: `${requestOrigin(request)}/oauth/google-calendar/callback`
        });
        return;
      }

      if (url.pathname === "/oauth/google-calendar/callback" && request.method === "GET") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          sendHtml(response, "Google Calendar 連接失敗", "Google 沒有回傳授權 code 或 state，請回 Dashboard 重新連接。", 400);
          return;
        }
        await completeGoogleCalendarOAuth(repo, { code, state, origin: requestOrigin(request) });
        await reschedule(repo);
        sendHtml(response, "Google Calendar 已連接", "你可以關閉這個分頁，回到 Dashboard 按刷新。");
        return;
      }
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      sendJson(response, { error: error instanceof Error ? error.message : "Unknown error" }, status);
      return;
    }

    if (url.pathname === "/api/tasks") {
      sendJson(response, { tasks: repo.listAllTasks() });
      return;
    }

    if (url.pathname === "/api/summary") {
      const tasks = attachSubtaskSummaries(repo, repo.listAllTasks());
      const now = new Date();
      const todayStart = startOfLocalDay(now).toISOString();
      const todayEnd = endOfLocalDay(now).toISOString();
      const weekEnd = startOfNextWeek(now).toISOString();
      const monthStart = startOfMonth(now).toISOString();
      const monthEnd = startOfNextMonth(now).toISOString();
      const prioritized = prioritizeTasks(tasks, now);
      const pendingTaskIds = new Set(tasks.filter((task) => !task.quadrant).map((task) => task.id));
      const actionablePriorities = prioritized.filter((task) => !pendingTaskIds.has(task.id));
      const completed = tasks.filter((task) => task.status === "done").sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      const calendar = await listCalendarEvents(repo, monthStart, monthEnd);
      const busyBlocks = calendarEventsToBusyBlocks(calendar.events);
      const workSettings = repo.getWorkSettings();
      const scheduleSegments = buildSchedule(tasks, now, busyBlocks, { dailyCapacityHours: workSettings.dailyWorkCapacityHours });
      sendJson(response, {
        total: tasks.length,
        active: tasks.filter((task) => !["done", "cancelled"].includes(task.status)).length,
        done: tasks.filter((task) => task.status === "done").length,
        pendingBucket: tasks.filter((task) => !["done", "cancelled"].includes(task.status) && !task.quadrant),
        missingDeadlines: tasks.filter((task) => !["done", "cancelled"].includes(task.status) && task.quadrant && !task.deadline),
        scheduleSegments,
        overdue: tasks.filter((task) => task.deadline && task.status !== "done" && new Date(task.deadline) < now).length,
        today: attachSubtaskSummaries(repo, repo.listScheduledBetween(todayStart, todayEnd)),
        week: attachSubtaskSummaries(repo, repo.listScheduledBetween(todayStart, weekEnd)),
        month: tasks
          .filter((task) => task.deadline && task.deadline >= monthStart && task.deadline < monthEnd && !["done", "cancelled"].includes(task.status))
          .sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime()),
        calendar,
        workSettings,
        completed,
        topPriorities: actionablePriorities.slice(0, 5),
        quadrants: groupQuadrants(actionablePriorities),
        byEnergy: countBy(tasks, "energy"),
        byStatus: countBy(tasks, "status")
      });
      return;
    }

    serveStatic(url.pathname, response);
  });

  server.listen(port);
  return server;
}

function groupQuadrants<T extends { quadrant: string }>(tasks: T[]): Record<string, T[]> {
  return {
    "urgent-important": tasks.filter((task) => task.quadrant === "urgent-important"),
    "urgent-not-important": tasks.filter((task) => task.quadrant === "urgent-not-important"),
    "not-urgent-important": tasks.filter((task) => task.quadrant === "not-urgent-important"),
    "not-urgent-not-important": tasks.filter((task) => task.quadrant === "not-urgent-not-important")
  };
}

const TaskInputSchema = z.object({
  title: z.string().trim().min(1),
  durationMinutes: z.number().int().positive().default(30),
  deadline: z.string().datetime().nullable().optional(),
  earliestStart: z.string().datetime().nullable().optional(),
  priority: z.number().int().min(1).max(5).default(3),
  energy: EnergySchema.default("medium"),
  quadrant: QuadrantSchema.nullable().optional(),
  context: z.string().trim().nullable().optional(),
  valueScore: z.number().int().min(1).max(5).default(3),
  deadlineType: DeadlineTypeSchema.default("none"),
  isProject: z.boolean().default(false),
  projectId: z.number().int().positive().nullable().optional(),
  progressNote: z.string().trim().nullable().optional()
});

const TaskPatchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  durationMinutes: z.number().int().positive().optional(),
  deadline: z.string().datetime().nullable().optional(),
  earliestStart: z.string().datetime().nullable().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  energy: EnergySchema.optional(),
  quadrant: QuadrantSchema.nullable().optional(),
  context: z.string().trim().nullable().optional(),
  status: TaskStatusSchema.optional(),
  valueScore: z.number().int().min(1).max(5).optional(),
  deadlineType: DeadlineTypeSchema.optional(),
  isProject: z.boolean().optional(),
  projectId: z.number().int().positive().nullable().optional(),
  progressNote: z.string().trim().nullable().optional()
});

const SyncInputSchema = z.object({
  listName: z.string().trim().min(1).default("全部")
});

const CalendarSettingsSchema = z.object({
  accountEmail: z.string().trim().email(),
  googleClientId: z.string().trim().optional(),
  googleClientSecret: z.string().trim().optional()
});

const PendingReviewSchema = z.object({
  limit: z.number().int().min(1).max(20).default(8)
});

const CheckInSchema = z.object({
  outcome: z.enum(["complete", "stuck", "defer"]),
  note: z.string().trim().nullable().optional()
});

const NextActionPreviewSchema = z.object({
  progressNote: z.string().trim().nullable().optional()
});

const SubtaskInputSchema = z.object({
  title: z.string().trim().min(1),
  status: SubtaskStatusSchema.default("pending"),
  followUpAt: z.string().datetime().nullable().optional(),
  completionDefinition: z.string().trim().nullable().optional(),
  note: z.string().trim().nullable().optional(),
  sortOrder: z.number().int().min(0).optional()
});

const SubtaskPatchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  status: SubtaskStatusSchema.optional(),
  followUpAt: z.string().datetime().nullable().optional(),
  completionDefinition: z.string().trim().nullable().optional(),
  note: z.string().trim().nullable().optional(),
  sortOrder: z.number().int().min(0).optional()
});

const SubtaskDecomposeSchema = z.object({
  note: z.string().trim().nullable().optional()
});

const SubtaskStuckSchema = z.object({
  note: z.string().trim().nullable().optional()
});

function sendJson(response: http.ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response: http.ServerResponse, title: string, message: string, status = 200): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;padding:40px;line-height:1.5;color:#243149;background:#f6f8fc}main{max-width:680px;margin:auto;padding:28px;border:1px solid #d8e0ec;border-radius:12px;background:white}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`
  );
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function reschedule(repo: AssistantRepository): Promise<void> {
  const now = new Date();
  const calendarEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const calendar = await listCalendarEvents(repo, now.toISOString(), calendarEnd.toISOString());
  repo.applySchedule(buildSchedule(repo.listActiveTasks(), now, calendarEventsToBusyBlocks(calendar.events), { dailyCapacityHours: repo.getWorkSettings().dailyWorkCapacityHours }));
}

function applyCheckIn(repo: AssistantRepository, task: Task, input: z.infer<typeof CheckInSchema>): Task {
  const note = input.note || task.progressNote;
  if (input.outcome === "complete") {
    return repo.updateTask(task.id, { status: "done", scheduledStart: null, scheduledEnd: null, progressNote: note ?? task.progressNote });
  }
  if (input.outcome === "stuck") {
    return repo.updateTask(task.id, {
      status: "in_progress",
      scheduledStart: null,
      scheduledEnd: null,
      progressNote: note ? `卡住：${note}` : "卡住，需要拆更小下一步。"
    });
  }
  return repo.updateTask(task.id, {
    status: "pending",
    scheduledStart: null,
    scheduledEnd: null,
    progressNote: note ? `延後：${note}` : "延後，等待重新安排。"
  });
}

async function nextActionPreview(project: Task, progressNote: string | null | undefined, minimax?: MiniMaxClient): Promise<NextActionSuggestion> {
  if (minimax) {
    try {
      return await minimax.suggestNextAction({ project, progressNote, now: new Date() });
    } catch (error) {
      console.warn("MiniMax next action preview failed, using fallback", error);
    }
  }
  return fallbackNextAction(project, progressNote);
}

async function subtaskDecompositionPreview(task: Task, note: string | null | undefined, minimax?: MiniMaxClient) {
  if (minimax) {
    try {
      return await minimax.decomposeTask({ task, note, now: new Date() });
    } catch (error) {
      console.warn("MiniMax subtask decomposition failed, using fallback", error);
    }
  }
  return buildSubtaskDecomposition(task, note);
}

async function triagePreview(task: Task, settings: z.infer<typeof WorkSettingsSchema>, minimax?: MiniMaxClient) {
  if (minimax) {
    try {
      return await minimax.triageTask({
        task,
        now: new Date(),
        dailyWorkCapacityHours: settings.dailyWorkCapacityHours,
        secretaryMvpMode: settings.secretaryMvpMode
      });
    } catch (error) {
      console.warn("MiniMax triage preview failed, using fallback", error);
    }
  }
  return buildTriageSuggestion(task, {
    now: new Date(),
    dailyWorkCapacityHours: settings.dailyWorkCapacityHours,
    secretaryMvpMode: settings.secretaryMvpMode
  });
}

function attachSubtaskSummaries<T extends Task>(repo: AssistantRepository, tasks: T[]): Array<T & { subtaskSummary: TaskSubtaskSummary }> {
  const summaries = repo.subtaskSummariesForTasks(tasks.map((task) => task.id));
  return tasks.map((task) => ({ ...task, subtaskSummary: summaries[task.id] || repo.subtaskSummary(task.id) }));
}

function calendarEventsToBusyBlocks(events: CalendarEvent[]): BusyBlock[] {
  return events.map((event) => ({
    start: event.start,
    end: event.end,
    title: event.title
  }));
}

function requestOrigin(request: http.IncomingMessage): string {
  const proto = request.headers["x-forwarded-proto"] || "http";
  return `${proto}://${request.headers.host || "localhost:8787"}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function startOfNextMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1, 0, 0, 0, 0);
}

function serveStatic(pathname: string, response: http.ServerResponse): void {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(publicDir, `.${safePath}`);

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": `${mime.getType(filePath) || "application/octet-stream"}; charset=utf-8`,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(response);
}

function countBy<T extends Record<string, unknown>>(items: T[], key: keyof T): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const value = String(item[key] ?? "unknown");
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

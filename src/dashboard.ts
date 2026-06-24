import http from "node:http";
import crypto from "node:crypto";
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
  DashboardUser,
  DashboardUserRoleSchema,
  DashboardUserStatusSchema,
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
import {
  buildGoogleLoginAuthUrl,
  exchangeGoogleLoginCode,
  fetchGoogleUserProfile,
  hasGoogleLoginCredentials,
  GoogleLoginConfig
} from "./googleAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

export type DashboardServerOptions = {
  auth?: {
    enabled?: boolean;
    publicOrigin?: string;
    adminEmails?: string[];
    sessionDays?: number;
    googleClientId?: string;
    googleClientSecret?: string;
  };
};

type DashboardAuthConfig = Required<NonNullable<DashboardServerOptions["auth"]>>;

export function startDashboardServer(repo: AssistantRepository, port: number, minimax?: MiniMaxClient, options: DashboardServerOptions = {}): http.Server {
  const auth = normalizeDashboardAuth(options.auth);
  if (auth.adminEmails.length) {
    repo.ensureDashboardAdminUsers(auth.adminEmails);
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const origin = requestOrigin(request, auth.publicOrigin);
    const dashboardUser = auth.enabled ? currentDashboardUser(repo, request) : null;

    if (auth.enabled) {
      const authHandled = await handleDashboardAuthRoute(repo, auth, request, response, url, origin, dashboardUser);
      if (authHandled) {
        return;
      }
      if (!dashboardUser) {
        rejectUnauthenticated(request, response, url);
        return;
      }
      if (url.pathname.startsWith("/api/admin") && dashboardUser.role !== "admin") {
        sendJson(response, { error: "只有管理員可以管理用戶。" }, 403);
        return;
      }
    }

    try {
      if (url.pathname === "/api/me" && request.method === "GET") {
        sendJson(response, {
          authEnabled: auth.enabled,
          user: dashboardUser
            ? publicDashboardUser(dashboardUser)
            : { id: 0, email: "local-dashboard", name: "本機模式", role: "admin", status: "active" },
          loginRedirectUri: `${origin}/oauth/google-login/callback`,
          calendarRedirectUri: `${origin}/oauth/google-calendar/callback`
        });
        return;
      }

      if (url.pathname === "/api/admin/users" && request.method === "GET") {
        sendJson(response, { users: repo.listDashboardUsers().map(publicDashboardUser) });
        return;
      }

      if (url.pathname === "/api/admin/users" && request.method === "POST") {
        const input = DashboardUserInputSchema.parse(await readJson(request));
        const user = repo.upsertDashboardUser(input);
        sendJson(response, { user: publicDashboardUser(user) }, 201);
        return;
      }

      const dashboardUserMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
      if (dashboardUserMatch && request.method === "PATCH") {
        const input = DashboardUserPatchSchema.parse(await readJson(request));
        const user = repo.updateDashboardUser(Number(dashboardUserMatch[1]), input);
        sendJson(response, { user: publicDashboardUser(user) });
        return;
      }

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

      if (subtaskMatch && request.method === "DELETE") {
        const subtaskId = Number(subtaskMatch[1]);
        const current = repo.getSubtask(subtaskId);
        if (!current) {
          sendJson(response, { error: "Subtask not found" }, 404);
          return;
        }
        repo.deleteSubtask(subtaskId);
        sendJson(response, { deleted: true, summary: repo.subtaskSummary(current.taskId) });
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
        const taskPatch = {
          ...input,
          scheduledStart: shouldClearSchedule ? null : current.scheduledStart,
          scheduledEnd: shouldClearSchedule ? null : current.scheduledEnd
        };
        if (["done", "cancelled"].includes(nextStatus)) {
          taskPatch.todayFocusOrder = null;
        }
        const updated = repo.updateTask(taskId, taskPatch);
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
        sendJson(response, calendarSettings(repo, origin));
        return;
      }

      if (url.pathname === "/api/calendar-settings" && request.method === "PUT") {
        const input = CalendarSettingsSchema.parse(await readJson(request));
        saveCalendarSettings(repo, input);
        sendJson(response, calendarSettings(repo, origin));
        return;
      }

      if (url.pathname === "/api/calendar-settings/google-auth-url" && request.method === "POST") {
        sendJson(response, {
          authUrl: createGoogleCalendarAuthUrl(repo, origin),
          redirectUri: `${origin}/oauth/google-calendar/callback`
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
        await completeGoogleCalendarOAuth(repo, { code, state, origin });
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
      const todayFocus = tasks
        .filter((task) => task.todayFocusOrder !== null && !["done", "cancelled"].includes(task.status))
        .sort((a, b) => (a.todayFocusOrder ?? Number.MAX_SAFE_INTEGER) - (b.todayFocusOrder ?? Number.MAX_SAFE_INTEGER));
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
        missingDeadlines: tasks.filter((task) => needsDueDate(task)),
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
        topPriorities: todayFocus,
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

function hasFollowUpAnchor(task: Task): boolean {
  return Boolean(task.isProject && task.nextReviewAt);
}

function needsDueDate(task: Task): boolean {
  if (["done", "cancelled"].includes(task.status)) return false;
  if (!task.quadrant || task.deadline) return false;
  if (task.quadrant === "urgent-important" || task.quadrant === "urgent-not-important") return true;
  return !hasFollowUpAnchor(task);
}

const TaskInputSchema = z.object({
  title: z.string().trim().min(1),
  durationMinutes: z.number().int().positive().default(30),
  deadline: z.string().datetime().nullable().optional(),
  earliestStart: z.string().datetime().nullable().optional(),
  nextReviewAt: z.string().datetime().nullable().optional(),
  reviewCadenceDays: z.number().int().positive().nullable().optional(),
  weeklyTargetMinutes: z.number().int().positive().nullable().optional(),
  priority: z.number().int().min(1).max(5).default(3),
  energy: EnergySchema.default("medium"),
  quadrant: QuadrantSchema.nullable().optional(),
  context: z.string().trim().nullable().optional(),
  valueScore: z.number().int().min(1).max(5).default(3),
  deadlineType: DeadlineTypeSchema.default("none"),
  isProject: z.boolean().default(false),
  projectId: z.number().int().positive().nullable().optional(),
  progressNote: z.string().trim().nullable().optional(),
  todayFocusOrder: z.number().int().positive().nullable().optional()
});

const TaskPatchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  durationMinutes: z.number().int().positive().optional(),
  deadline: z.string().datetime().nullable().optional(),
  earliestStart: z.string().datetime().nullable().optional(),
  nextReviewAt: z.string().datetime().nullable().optional(),
  reviewCadenceDays: z.number().int().positive().nullable().optional(),
  weeklyTargetMinutes: z.number().int().positive().nullable().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  energy: EnergySchema.optional(),
  quadrant: QuadrantSchema.nullable().optional(),
  context: z.string().trim().nullable().optional(),
  status: TaskStatusSchema.optional(),
  valueScore: z.number().int().min(1).max(5).optional(),
  deadlineType: DeadlineTypeSchema.optional(),
  isProject: z.boolean().optional(),
  projectId: z.number().int().positive().nullable().optional(),
  progressNote: z.string().trim().nullable().optional(),
  todayFocusOrder: z.number().int().positive().nullable().optional()
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

const DashboardUserInputSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  name: z.string().trim().nullable().optional(),
  role: DashboardUserRoleSchema.default("user"),
  status: DashboardUserStatusSchema.default("active")
});

const DashboardUserPatchSchema = z.object({
  name: z.string().trim().nullable().optional(),
  role: DashboardUserRoleSchema.optional(),
  status: DashboardUserStatusSchema.optional()
});

function normalizeDashboardAuth(input: DashboardServerOptions["auth"]): DashboardAuthConfig {
  return {
    enabled: Boolean(input?.enabled),
    publicOrigin: input?.publicOrigin?.replace(/\/$/, "") || "",
    adminEmails: [...new Set((input?.adminEmails || []).map((email) => email.trim().toLowerCase()).filter(Boolean))],
    sessionDays: input?.sessionDays && input.sessionDays > 0 ? input.sessionDays : 30,
    googleClientId: input?.googleClientId || "",
    googleClientSecret: input?.googleClientSecret || ""
  };
}

async function handleDashboardAuthRoute(
  repo: AssistantRepository,
  auth: DashboardAuthConfig,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  origin: string,
  dashboardUser: DashboardUser | null
): Promise<boolean> {
  if (url.pathname === "/login" && request.method === "GET") {
    sendLoginPage(response, {
      origin,
      user: dashboardUser,
      error: url.searchParams.get("error") || "",
      hasGoogleCredentials: hasGoogleLoginCredentials(getGoogleLoginConfig(repo, auth))
    });
    return true;
  }

  if (url.pathname === "/auth/google" && request.method === "GET") {
    try {
      const state = crypto.randomBytes(18).toString("hex");
      const authUrl = buildGoogleLoginAuthUrl(getGoogleLoginConfig(repo, auth), googleLoginRedirectUri(origin), state);
      appendSetCookie(response, cookie("pa_oauth_state", state, { maxAgeSeconds: 10 * 60, httpOnly: true, secure: isSecureRequest(request, origin) }));
      redirect(response, authUrl);
    } catch (error) {
      redirect(response, `/login?error=${encodeURIComponent(error instanceof Error ? error.message : "Google 登入設定錯誤")}`);
    }
    return true;
  }

  if (url.pathname === "/oauth/google-login/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expectedState = cookieValue(request, "pa_oauth_state");
    appendSetCookie(response, clearCookie("pa_oauth_state"));
    if (!code || !state || !expectedState || state !== expectedState) {
      redirect(response, `/login?error=${encodeURIComponent("Google 登入 state 不一致，請重新登入。")}`);
      return true;
    }

    try {
      const accessToken = await exchangeGoogleLoginCode(getGoogleLoginConfig(repo, auth), code, googleLoginRedirectUri(origin));
      const profile = await fetchGoogleUserProfile(accessToken);
      if (!profile.emailVerified) {
        throw new Error("Google email 尚未驗證，不能登入。");
      }
      let user = repo.getDashboardUserByEmail(profile.email);
      if (!user && auth.adminEmails.includes(profile.email)) {
        user = repo.upsertDashboardUser({ email: profile.email, name: profile.name, role: "admin", status: "active" });
      }
      if (!user) {
        throw new Error("此 Google 帳號未被加入後台用戶。請先由管理員加入。");
      }
      if (user.status !== "active") {
        throw new Error("此後台用戶已停用。");
      }
      if (profile.name && profile.name !== user.name) {
        user = repo.updateDashboardUser(user.id, { name: profile.name });
      }
      repo.markDashboardUserLogin(user.id);
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + auth.sessionDays * 24 * 60 * 60 * 1000).toISOString();
      repo.createDashboardSession({ tokenHash: sessionTokenHash(token), userId: user.id, expiresAt });
      appendSetCookie(response, cookie("pa_session", token, { maxAgeSeconds: auth.sessionDays * 24 * 60 * 60, httpOnly: true, secure: isSecureRequest(request, origin) }));
      redirect(response, "/");
    } catch (error) {
      redirect(response, `/login?error=${encodeURIComponent(error instanceof Error ? error.message : "Google 登入失敗")}`);
    }
    return true;
  }

  if (url.pathname === "/logout" && (request.method === "GET" || request.method === "POST")) {
    const token = cookieValue(request, "pa_session");
    if (token) {
      repo.deleteDashboardSession(sessionTokenHash(token));
    }
    appendSetCookie(response, clearCookie("pa_session"));
    redirect(response, "/login");
    return true;
  }

  return false;
}

function currentDashboardUser(repo: AssistantRepository, request: http.IncomingMessage): DashboardUser | null {
  const token = cookieValue(request, "pa_session");
  if (!token) {
    return null;
  }
  const session = repo.getDashboardSession(sessionTokenHash(token));
  if (!session || session.user.status !== "active") {
    return null;
  }
  return session.user;
}

function getGoogleLoginConfig(repo: AssistantRepository, auth: DashboardAuthConfig): GoogleLoginConfig {
  return {
    clientId: auth.googleClientId || repo.getSetting("google_calendar_client_id"),
    clientSecret: auth.googleClientSecret || repo.getSetting("google_calendar_client_secret")
  };
}

function googleLoginRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, "")}/oauth/google-login/callback`;
}

function rejectUnauthenticated(request: http.IncomingMessage, response: http.ServerResponse, url: URL): void {
  if (url.pathname.startsWith("/api/")) {
    sendJson(response, { error: "請先用 Google 登入。" }, 401);
    return;
  }
  if (request.method === "GET") {
    redirect(response, `/login?next=${encodeURIComponent(url.pathname)}`);
    return;
  }
  sendJson(response, { error: "請先用 Google 登入。" }, 401);
}

function publicDashboardUser(user: DashboardUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

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

function sendLoginPage(
  response: http.ServerResponse,
  input: { origin: string; user: DashboardUser | null; error: string; hasGoogleCredentials: boolean }
): void {
  const loginUri = googleLoginRedirectUri(input.origin);
  const calendarUri = `${input.origin.replace(/\/$/, "")}/oauth/google-calendar/callback`;
  const credentialNote = input.hasGoogleCredentials
    ? "OAuth 憑證已找到，可以用 Google 登入。"
    : "尚未設定 Google OAuth Client ID / Secret。請先在 .env 設 GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET，或在未啟用登入前於日曆設定儲存。";
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>登入個人排程助理</title>
    <style>
      :root{color-scheme:light;--text:#243149;--muted:#68758a;--line:#d9e2ef;--accent:#4da7aa}
      *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#f8fbff,#eef7f3);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text)}
      main{width:min(720px,calc(100vw - 32px));padding:34px;border:1px solid var(--line);border-radius:18px;background:rgba(255,255,255,.88);box-shadow:0 24px 70px rgba(72,91,125,.14)}
      h1{margin:0 0 10px;font-size:34px;letter-spacing:0}p{margin:0;color:var(--muted);line-height:1.55}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:26px 0 18px}
      a.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 18px;border:1px solid rgba(77,167,170,.35);border-radius:10px;background:var(--accent);color:white;text-decoration:none;font-weight:800}
      .error{margin-top:16px;padding:12px 14px;border:1px solid rgba(213,83,91,.28);border-radius:10px;background:#fff5f5;color:#b74750;font-weight:700}
      .note{display:grid;gap:8px;margin-top:18px;padding:14px;border:1px solid var(--line);border-radius:12px;background:#fbfdff}.note code{color:#2d6f73;word-break:break-all}
    </style>
  </head>
  <body>
    <main>
      <p>Personal Assistant</p>
      <h1>用 Google 登入</h1>
      <p>只有已加入後台用戶的 Google 帳號可以進入你的個人排程助理。</p>
      ${input.error ? `<div class="error">${escapeHtml(input.error)}</div>` : ""}
      ${input.user ? `<div class="error">你已登入：${escapeHtml(input.user.email)}。<a href="/" style="color:inherit">返回 Dashboard</a></div>` : ""}
      <div class="actions"><a class="button" href="/auth/google">以 Google 繼續</a><a href="/logout">登出現有 session</a></div>
      <div class="note">
        <strong>OAuth 設定</strong>
        <p>${escapeHtml(credentialNote)}</p>
        <p>Google Login Redirect URI：<code>${escapeHtml(loginUri)}</code></p>
        <p>Google Calendar Redirect URI：<code>${escapeHtml(calendarUri)}</code></p>
      </div>
    </main>
  </body>
</html>`);
}

function redirect(response: http.ServerResponse, location: string): void {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

function cookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; httpOnly?: boolean; secure?: boolean }
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, options.maxAgeSeconds)}`,
    "SameSite=Lax",
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : ""
  ]
    .filter(Boolean)
    .join("; ");
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`;
}

function appendSetCookie(response: http.ServerResponse, value: string): void {
  const current = response.getHeader("Set-Cookie");
  if (!current) {
    response.setHeader("Set-Cookie", value);
    return;
  }
  response.setHeader("Set-Cookie", Array.isArray(current) ? [...current.map(String), value] : [String(current), value]);
}

function cookieValue(request: http.IncomingMessage, name: string): string {
  const raw = request.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return "";
}

function sessionTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isSecureRequest(request: http.IncomingMessage, origin: string): boolean {
  return origin.startsWith("https://") || request.headers["x-forwarded-proto"] === "https";
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
    return repo.updateTask(task.id, { status: "done", scheduledStart: null, scheduledEnd: null, progressNote: note ?? task.progressNote, todayFocusOrder: null });
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

function requestOrigin(request: http.IncomingMessage, publicOrigin = ""): string {
  if (publicOrigin) {
    return publicOrigin.replace(/\/$/, "");
  }
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

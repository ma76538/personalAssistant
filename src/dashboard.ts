import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mime from "mime";
import { z } from "zod";
import { AssistantRepository } from "./db.js";
import { syncAppleReminders } from "./appleReminders.js";
import { buildSchedule } from "./scheduler.js";
import { prioritizeTasks } from "./prioritizer.js";
import { endOfLocalDay, startOfLocalDay, startOfNextWeek } from "./time.js";
import { EnergySchema, ReminderPolicySchema, TaskStatusSchema } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

export function startDashboardServer(repo: AssistantRepository, port: number): http.Server {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    try {
      if (url.pathname === "/api/tasks" && request.method === "GET") {
        sendJson(response, { tasks: repo.listAllTasks() });
        return;
      }

      if (url.pathname === "/api/tasks" && request.method === "POST") {
        const input = TaskInputSchema.parse(await readJson(request));
        const task = repo.addTask(input);
        reschedule(repo);
        sendJson(response, { task: repo.getTask(task.id) }, 201);
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
        repo.updateTask(taskId, {
          ...input,
          scheduledStart: nextStatus === "pending" || nextStatus === "scheduled" ? null : current.scheduledStart,
          scheduledEnd: nextStatus === "pending" || nextStatus === "scheduled" ? null : current.scheduledEnd
        });
        reschedule(repo);
        sendJson(response, { task: repo.getTask(taskId) });
        return;
      }

      const actionMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/(done|cancel)$/);
      if (actionMatch && request.method === "POST") {
        const taskId = Number(actionMatch[1]);
        const status = actionMatch[2] === "done" ? "done" : "cancelled";
        repo.updateTask(taskId, { status, scheduledStart: null, scheduledEnd: null });
        reschedule(repo);
        sendJson(response, { task: repo.getTask(taskId) });
        return;
      }

      if (url.pathname === "/api/replan" && request.method === "POST") {
        reschedule(repo);
        sendJson(response, { tasks: repo.listAllTasks() });
        return;
      }

      if (url.pathname === "/api/sync/apple-reminders" && request.method === "POST") {
        const input = SyncInputSchema.parse(await readJson(request));
        const result = syncAppleReminders(repo, input.listName);
        reschedule(repo);
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
      const tasks = repo.listAllTasks();
      const now = new Date();
      const todayStart = startOfLocalDay(now).toISOString();
      const todayEnd = endOfLocalDay(now).toISOString();
      const weekEnd = startOfNextWeek(now).toISOString();
      const prioritized = prioritizeTasks(tasks, now);
      sendJson(response, {
        total: tasks.length,
        active: tasks.filter((task) => !["done", "cancelled"].includes(task.status)).length,
        done: tasks.filter((task) => task.status === "done").length,
        overdue: tasks.filter((task) => task.deadline && task.status !== "done" && new Date(task.deadline) < now).length,
        today: repo.listScheduledBetween(todayStart, todayEnd),
        week: repo.listScheduledBetween(todayStart, weekEnd),
        topPriorities: prioritized.slice(0, 5),
        quadrants: groupQuadrants(prioritized),
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
  context: z.string().trim().nullable().optional()
});

const TaskPatchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  durationMinutes: z.number().int().positive().optional(),
  deadline: z.string().datetime().nullable().optional(),
  earliestStart: z.string().datetime().nullable().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  energy: EnergySchema.optional(),
  context: z.string().trim().nullable().optional(),
  status: TaskStatusSchema.optional()
});

const SyncInputSchema = z.object({
  listName: z.string().trim().min(1).default("提醒事項")
});

function sendJson(response: http.ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function reschedule(repo: AssistantRepository): void {
  repo.applySchedule(buildSchedule(repo.listActiveTasks()));
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

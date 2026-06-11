import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_REMINDER_POLICY, PendingAction, PendingActionSchema, ReminderPolicy, ReminderPolicySchema, ReminderStage, Task } from "./types.js";
import { nowIso } from "./time.js";

export class AssistantRepository {
  private db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        deadline TEXT,
        earliest_start TEXT,
        priority INTEGER NOT NULL DEFAULT 3,
        energy TEXT NOT NULL DEFAULT 'medium',
        context TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        scheduled_start TEXT,
        scheduled_end TEXT,
        quadrant TEXT,
        source TEXT,
        source_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_actions (
        chat_id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reminder_events (
        task_id INTEGER NOT NULL,
        stage TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (task_id, stage)
      );

      CREATE TABLE IF NOT EXISTS daily_briefs (
        brief_date TEXT PRIMARY KEY,
        sent_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("tasks", "source", "TEXT");
    this.ensureColumn("tasks", "source_id", "TEXT");
    this.ensureColumn("tasks", "quadrant", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source ON tasks (source, source_id) WHERE source IS NOT NULL AND source_id IS NOT NULL");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  addTask(input: {
    title: string;
    durationMinutes?: number;
    deadline?: string | null;
    earliestStart?: string | null;
    priority?: number;
    energy?: string;
    context?: string | null;
    quadrant?: Task["quadrant"];
    source?: string | null;
    sourceId?: string | null;
  }): Task {
    const timestamp = nowIso();
    const statement = this.db.prepare(`
      INSERT INTO tasks (
        title, duration_minutes, deadline, earliest_start, priority, energy, context,
        quadrant, source, source_id, status, created_at, updated_at
      ) VALUES (
        @title, @durationMinutes, @deadline, @earliestStart, @priority, @energy, @context,
        @quadrant, @source, @sourceId, 'pending', @createdAt, @updatedAt
      )
    `);
    const result = statement.run({
      title: input.title,
      durationMinutes: input.durationMinutes ?? 30,
      deadline: input.deadline ?? null,
      earliestStart: input.earliestStart ?? null,
      priority: input.priority ?? 3,
      energy: input.energy ?? "medium",
      context: input.context ?? null,
      quadrant: input.quadrant ?? null,
      source: input.source ?? null,
      sourceId: input.sourceId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    return this.getTask(Number(result.lastInsertRowid))!;
  }

  upsertExternalTask(input: {
    source: string;
    sourceId: string;
    title: string;
    durationMinutes?: number;
    deadline?: string | null;
    priority?: number;
    energy?: string;
    context?: string | null;
    quadrant?: Task["quadrant"];
  }): Task {
    const existing = this.db
      .prepare("SELECT * FROM tasks WHERE source = ? AND source_id = ? LIMIT 1")
      .get(input.source, input.sourceId) as Record<string, unknown> | undefined;

    if (!existing) {
      return this.addTask(input);
    }

    const task = this.mapTask(existing);
    return this.updateTask(task.id, {
      title: input.title,
      durationMinutes: input.durationMinutes ?? task.durationMinutes,
      deadline: input.deadline === undefined ? task.deadline : input.deadline,
      priority: input.priority ?? task.priority,
      energy: (input.energy ?? task.energy) as Task["energy"],
      context: input.context === undefined ? task.context : input.context,
      quadrant: input.quadrant ?? task.quadrant,
      status: task.status === "done" || task.status === "cancelled" ? task.status : "pending",
      scheduledStart: null,
      scheduledEnd: null,
      source: input.source,
      sourceId: input.sourceId
    });
  }

  getTask(id: number): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? this.mapTask(row as Record<string, unknown>) : null;
  }

  listActiveTasks(): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status NOT IN ('done', 'cancelled') ORDER BY priority DESC, deadline IS NULL, deadline ASC")
      .all()
      .map((row) => this.mapTask(row as Record<string, unknown>));
  }

  listAllTasks(): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY scheduled_start IS NULL, scheduled_start ASC, updated_at DESC")
      .all()
      .map((row) => this.mapTask(row as Record<string, unknown>));
  }

  listExternalTasks(source: string): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE source = ? ORDER BY updated_at DESC")
      .all(source)
      .map((row) => this.mapTask(row as Record<string, unknown>));
  }

  deleteTask(id: number): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteTasksByStatus(status: Task["status"]): number {
    const result = this.db.prepare("DELETE FROM tasks WHERE status = ?").run(status);
    return result.changes;
  }

  listScheduledBetween(startIso: string, endIso: string): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE scheduled_start IS NOT NULL
           AND scheduled_start >= ?
           AND scheduled_start <= ?
           AND status NOT IN ('done', 'cancelled')
         ORDER BY scheduled_start ASC`
      )
      .all(startIso, endIso)
      .map((row) => this.mapTask(row as Record<string, unknown>));
  }

  findTask(target: string): Task | null {
    const numericId = Number(target.trim());
    if (Number.isInteger(numericId) && numericId > 0) {
      return this.getTask(numericId);
    }
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE title LIKE ? AND status NOT IN ('done', 'cancelled') ORDER BY updated_at DESC LIMIT 1")
      .get(`%${target}%`);
    return row ? this.mapTask(row as Record<string, unknown>) : null;
  }

  updateTask(id: number, patch: Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>): Task {
    const current = this.getTask(id);
    if (!current) {
      throw new Error(`Task ${id} not found`);
    }
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE tasks SET
          title = @title,
          duration_minutes = @durationMinutes,
          deadline = @deadline,
          earliest_start = @earliestStart,
          priority = @priority,
          energy = @energy,
          context = @context,
          status = @status,
          scheduled_start = @scheduledStart,
          scheduled_end = @scheduledEnd,
          quadrant = @quadrant,
          source = @source,
          source_id = @sourceId,
          updated_at = @updatedAt
        WHERE id = @id`
      )
      .run(next);
    return this.getTask(id)!;
  }

  markExternalTasksStatus(source: string, sourceIds: string[], status: Task["status"]): number {
    if (sourceIds.length === 0) {
      return 0;
    }
    const placeholders = sourceIds.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, scheduled_start = NULL, scheduled_end = NULL, updated_at = ?
         WHERE source = ?
           AND source_id IN (${placeholders})`
      )
      .run(status, nowIso(), source, ...sourceIds);
    return result.changes;
  }

  deleteExternalTasksBySourceIds(source: string, sourceIds: string[]): number {
    if (sourceIds.length === 0) {
      return 0;
    }
    const placeholders = sourceIds.map(() => "?").join(",");
    const result = this.db.prepare(`DELETE FROM tasks WHERE source = ? AND source_id IN (${placeholders})`).run(source, ...sourceIds);
    return result.changes;
  }

  deleteTasksMissingFromSource(source: string, knownSourceIds: string[]): number {
    if (knownSourceIds.length === 0) {
      const result = this.db.prepare("DELETE FROM tasks WHERE source = ?").run(source);
      return result.changes;
    }
    const placeholders = knownSourceIds.map(() => "?").join(",");
    const result = this.db.prepare(`DELETE FROM tasks WHERE source = ? AND source_id NOT IN (${placeholders})`).run(source, ...knownSourceIds);
    return result.changes;
  }

  deleteUnsourcedActiveTasks(): number {
    const result = this.db.prepare("DELETE FROM tasks WHERE source IS NULL AND status NOT IN ('done', 'cancelled')").run();
    return result.changes;
  }

  markMissingExternalTasksStatus(source: string, knownSourceIds: string[], status: Task["status"]): number {
    const timestamp = nowIso();
    if (knownSourceIds.length === 0) {
      const result = this.db
        .prepare(
          `UPDATE tasks
           SET status = ?, scheduled_start = NULL, scheduled_end = NULL, updated_at = ?
           WHERE source = ?
             AND status NOT IN ('done', 'cancelled')`
        )
        .run(status, timestamp, source);
      return result.changes;
    }

    const placeholders = knownSourceIds.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, scheduled_start = NULL, scheduled_end = NULL, updated_at = ?
         WHERE source = ?
           AND status NOT IN ('done', 'cancelled')
           AND source_id NOT IN (${placeholders})`
      )
      .run(status, timestamp, source, ...knownSourceIds);
    return result.changes;
  }

  applySchedule(plan: Array<{ taskId: number; scheduledStart: string; scheduledEnd: string }>): void {
    const clearMovable = this.db.prepare(
      "UPDATE tasks SET scheduled_start = NULL, scheduled_end = NULL, status = 'pending', updated_at = ? WHERE status IN ('pending', 'scheduled')"
    );
    const update = this.db.prepare(
      "UPDATE tasks SET scheduled_start = ?, scheduled_end = ?, status = 'scheduled', updated_at = ? WHERE id = ? AND status IN ('pending', 'scheduled')"
    );
    const transaction = this.db.transaction(() => {
      clearMovable.run(nowIso());
      for (const item of plan) {
        update.run(item.scheduledStart, item.scheduledEnd, nowIso(), item.taskId);
      }
    });
    transaction();
  }

  savePendingAction(chatId: number, action: PendingAction): void {
    this.db
      .prepare(
        `INSERT INTO pending_actions (chat_id, payload, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`
      )
      .run(chatId, JSON.stringify(action), nowIso());
  }

  getPendingAction(chatId: number): PendingAction | null {
    const row = this.db.prepare("SELECT payload FROM pending_actions WHERE chat_id = ?").get(chatId) as { payload?: string } | undefined;
    if (!row?.payload) {
      return null;
    }
    return PendingActionSchema.parse(JSON.parse(row.payload));
  }

  clearPendingAction(chatId: number): void {
    this.db.prepare("DELETE FROM pending_actions WHERE chat_id = ?").run(chatId);
  }

  hasReminder(taskId: number, stage: ReminderStage): boolean {
    const row = this.db.prepare("SELECT 1 FROM reminder_events WHERE task_id = ? AND stage = ?").get(taskId, stage);
    return Boolean(row);
  }

  markReminder(taskId: number, stage: ReminderStage): void {
    this.db
      .prepare("INSERT OR IGNORE INTO reminder_events (task_id, stage, sent_at) VALUES (?, ?, ?)")
      .run(taskId, stage, nowIso());
  }

  hasDailyBrief(briefDate: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM daily_briefs WHERE brief_date = ?").get(briefDate);
    return Boolean(row);
  }

  markDailyBrief(briefDate: string): void {
    this.db.prepare("INSERT OR IGNORE INTO daily_briefs (brief_date, sent_at) VALUES (?, ?)").run(briefDate, nowIso());
  }

  getReminderPolicy(): ReminderPolicy {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get("reminder_policy") as { value?: string } | undefined;
    if (!row?.value) {
      return this.resetReminderPolicy();
    }

    try {
      return ReminderPolicySchema.parse(JSON.parse(row.value));
    } catch {
      return this.resetReminderPolicy();
    }
  }

  saveReminderPolicy(policy: ReminderPolicy): ReminderPolicy {
    const parsed = ReminderPolicySchema.parse(policy);
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run("reminder_policy", JSON.stringify(parsed), nowIso());
    return parsed;
  }

  resetReminderPolicy(): ReminderPolicy {
    return this.saveReminderPolicy(DEFAULT_REMINDER_POLICY);
  }

  private mapTask(row: Record<string, unknown>): Task {
    return {
      id: Number(row.id),
      title: String(row.title),
      durationMinutes: Number(row.duration_minutes),
      deadline: row.deadline ? String(row.deadline) : null,
      earliestStart: row.earliest_start ? String(row.earliest_start) : null,
      priority: Number(row.priority),
      energy: row.energy as Task["energy"],
      context: row.context ? String(row.context) : null,
      status: row.status as Task["status"],
      scheduledStart: row.scheduled_start ? String(row.scheduled_start) : null,
      scheduledEnd: row.scheduled_end ? String(row.scheduled_end) : null,
      quadrant: row.quadrant ? (String(row.quadrant) as Task["quadrant"]) : null,
      source: row.source ? String(row.source) : null,
      sourceId: row.source_id ? String(row.source_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}

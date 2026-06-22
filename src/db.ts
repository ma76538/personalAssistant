import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_REMINDER_POLICY,
  DeadlineType,
  DEFAULT_WORK_SETTINGS,
  PendingAction,
  PendingActionSchema,
  ReminderPolicy,
  ReminderPolicySchema,
  ReminderStage,
  SubtaskStatus,
  Task,
  TaskSubtask,
  TaskSubtaskSummary,
  WorkSettings,
  WorkSettingsSchema
} from "./types.js";
import { nowIso } from "./time.js";

export class AssistantRepository {
  private db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
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

      CREATE TABLE IF NOT EXISTS task_subtasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        follow_up_at TEXT,
        completion_definition TEXT,
        note TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);
    this.ensureColumn("tasks", "source", "TEXT");
    this.ensureColumn("tasks", "source_id", "TEXT");
    this.ensureColumn("tasks", "quadrant", "TEXT");
    this.ensureColumn("tasks", "value_score", "INTEGER NOT NULL DEFAULT 3");
    this.ensureColumn("tasks", "deadline_type", "TEXT NOT NULL DEFAULT 'none'");
    this.ensureColumn("tasks", "is_project", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "project_id", "INTEGER");
    this.ensureColumn("tasks", "progress_note", "TEXT");
    this.ensureColumn("tasks", "next_review_at", "TEXT");
    this.ensureColumn("tasks", "review_cadence_days", "INTEGER");
    this.ensureColumn("tasks", "weekly_target_minutes", "INTEGER");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source ON tasks (source, source_id) WHERE source IS NOT NULL AND source_id IS NOT NULL");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_task_subtasks_task ON task_subtasks (task_id, sort_order, id)");
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
    nextReviewAt?: string | null;
    reviewCadenceDays?: number | null;
    weeklyTargetMinutes?: number | null;
    priority?: number;
    energy?: string;
    context?: string | null;
    quadrant?: Task["quadrant"];
    valueScore?: number;
    deadlineType?: DeadlineType;
    isProject?: boolean;
    projectId?: number | null;
    progressNote?: string | null;
    source?: string | null;
    sourceId?: string | null;
  }): Task {
    const timestamp = nowIso();
    const statement = this.db.prepare(`
      INSERT INTO tasks (
        title, duration_minutes, deadline, earliest_start, priority, energy, context,
        quadrant, value_score, deadline_type, is_project, project_id, progress_note,
        next_review_at, review_cadence_days, weekly_target_minutes,
        source, source_id, status, created_at, updated_at
      ) VALUES (
        @title, @durationMinutes, @deadline, @earliestStart, @priority, @energy, @context,
        @quadrant, @valueScore, @deadlineType, @isProject, @projectId, @progressNote,
        @nextReviewAt, @reviewCadenceDays, @weeklyTargetMinutes,
        @source, @sourceId, 'pending', @createdAt, @updatedAt
      )
    `);
    const result = statement.run({
      title: input.title,
      durationMinutes: input.durationMinutes ?? 30,
      deadline: input.deadline ?? null,
      earliestStart: input.earliestStart ?? null,
      nextReviewAt: input.nextReviewAt ?? null,
      reviewCadenceDays: input.reviewCadenceDays ?? null,
      weeklyTargetMinutes: input.weeklyTargetMinutes ?? null,
      priority: input.priority ?? 3,
      energy: input.energy ?? "medium",
      context: input.context ?? null,
      quadrant: input.quadrant ?? null,
      valueScore: input.valueScore ?? 3,
      deadlineType: input.deadlineType ?? "none",
      isProject: input.isProject ? 1 : 0,
      projectId: input.projectId ?? null,
      progressNote: input.progressNote ?? null,
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
    nextReviewAt?: string | null;
    reviewCadenceDays?: number | null;
    weeklyTargetMinutes?: number | null;
    priority?: number;
    energy?: string;
    context?: string | null;
    quadrant?: Task["quadrant"];
    valueScore?: number;
    deadlineType?: DeadlineType;
    isProject?: boolean;
    projectId?: number | null;
    progressNote?: string | null;
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
      nextReviewAt: input.nextReviewAt === undefined ? task.nextReviewAt : input.nextReviewAt,
      reviewCadenceDays: input.reviewCadenceDays === undefined ? task.reviewCadenceDays : input.reviewCadenceDays,
      weeklyTargetMinutes: input.weeklyTargetMinutes === undefined ? task.weeklyTargetMinutes : input.weeklyTargetMinutes,
      priority: input.priority ?? task.priority,
      energy: (input.energy ?? task.energy) as Task["energy"],
      context: input.context === undefined ? task.context : input.context,
      quadrant: input.quadrant ?? task.quadrant,
      valueScore: input.valueScore ?? task.valueScore,
      deadlineType: input.deadlineType ?? task.deadlineType,
      isProject: input.isProject ?? task.isProject,
      projectId: input.projectId === undefined ? task.projectId : input.projectId,
      progressNote: input.progressNote === undefined ? task.progressNote : input.progressNote,
      status: task.status === "done" || task.status === "cancelled" ? "pending" : task.status,
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

  addSubtask(input: {
    taskId: number;
    title: string;
    status?: SubtaskStatus;
    followUpAt?: string | null;
    completionDefinition?: string | null;
    note?: string | null;
    sortOrder?: number;
  }): TaskSubtask {
    if (!this.getTask(input.taskId)) {
      throw new Error(`Task ${input.taskId} not found`);
    }
    const timestamp = nowIso();
    const nextOrder =
      input.sortOrder ??
      Number((this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM task_subtasks WHERE task_id = ?").get(input.taskId) as { next_order: number }).next_order);
    const result = this.db
      .prepare(
        `INSERT INTO task_subtasks (
          task_id, title, status, follow_up_at, completion_definition, note, sort_order, created_at, updated_at
        ) VALUES (
          @taskId, @title, @status, @followUpAt, @completionDefinition, @note, @sortOrder, @createdAt, @updatedAt
        )`
      )
      .run({
        taskId: input.taskId,
        title: input.title,
        status: input.status ?? "pending",
        followUpAt: input.followUpAt ?? null,
        completionDefinition: input.completionDefinition ?? null,
        note: input.note ?? null,
        sortOrder: nextOrder,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    this.touchTask(input.taskId);
    return this.getSubtask(Number(result.lastInsertRowid))!;
  }

  getSubtask(id: number): TaskSubtask | null {
    const row = this.db.prepare("SELECT * FROM task_subtasks WHERE id = ?").get(id);
    return row ? this.mapSubtask(row as Record<string, unknown>) : null;
  }

  listSubtasks(taskId: number): TaskSubtask[] {
    return this.db
      .prepare("SELECT * FROM task_subtasks WHERE task_id = ? ORDER BY sort_order ASC, id ASC")
      .all(taskId)
      .map((row) => this.mapSubtask(row as Record<string, unknown>));
  }

  listSubtasksForTasks(taskIds: number[]): Record<number, TaskSubtask[]> {
    if (taskIds.length === 0) {
      return {};
    }
    const placeholders = taskIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM task_subtasks WHERE task_id IN (${placeholders}) ORDER BY task_id ASC, sort_order ASC, id ASC`).all(...taskIds);
    const grouped: Record<number, TaskSubtask[]> = {};
    for (const row of rows) {
      const subtask = this.mapSubtask(row as Record<string, unknown>);
      grouped[subtask.taskId] = grouped[subtask.taskId] || [];
      grouped[subtask.taskId].push(subtask);
    }
    return grouped;
  }

  updateSubtask(id: number, patch: Partial<Omit<TaskSubtask, "id" | "taskId" | "createdAt" | "updatedAt">>): TaskSubtask {
    const current = this.getSubtask(id);
    if (!current) {
      throw new Error(`Subtask ${id} not found`);
    }
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE task_subtasks SET
          title = @title,
          status = @status,
          follow_up_at = @followUpAt,
          completion_definition = @completionDefinition,
          note = @note,
          sort_order = @sortOrder,
          updated_at = @updatedAt
        WHERE id = @id`
      )
      .run(next);
    this.touchTask(current.taskId);
    return this.getSubtask(id)!;
  }

  deleteSubtask(id: number): boolean {
    const current = this.getSubtask(id);
    if (!current) {
      return false;
    }
    const result = this.db.prepare("DELETE FROM task_subtasks WHERE id = ?").run(id);
    this.touchTask(current.taskId);
    return result.changes > 0;
  }

  completeNextSubtask(taskId: number): TaskSubtask | null {
    const next = this.nextOpenSubtask(taskId);
    return next ? this.updateSubtask(next.id, { status: "done" }) : null;
  }

  markNextSubtaskBlocked(taskId: number, note?: string | null): TaskSubtask | null {
    const next = this.nextOpenSubtask(taskId);
    return next ? this.updateSubtask(next.id, { status: "blocked", note: note || next.note || "卡住，需要拆更細下一步。" }) : null;
  }

  subtaskSummary(taskId: number): TaskSubtaskSummary {
    return summarizeSubtasks(this.listSubtasks(taskId));
  }

  subtaskSummariesForTasks(taskIds: number[]): Record<number, TaskSubtaskSummary> {
    const grouped = this.listSubtasksForTasks(taskIds);
    return Object.fromEntries(taskIds.map((taskId) => [taskId, summarizeSubtasks(grouped[taskId] || [])]));
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
          next_review_at = @nextReviewAt,
          review_cadence_days = @reviewCadenceDays,
          weekly_target_minutes = @weeklyTargetMinutes,
          priority = @priority,
          energy = @energy,
          context = @context,
          status = @status,
          scheduled_start = @scheduledStart,
          scheduled_end = @scheduledEnd,
          quadrant = @quadrant,
          value_score = @valueScore,
          deadline_type = @deadlineType,
          is_project = @isProject,
          project_id = @projectId,
          progress_note = @progressNote,
          source = @source,
          source_id = @sourceId,
          updated_at = @updatedAt
        WHERE id = @id`
      )
      .run({ ...next, isProject: next.isProject ? 1 : 0 });
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
      for (const item of aggregateSchedule(plan)) {
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

  getWorkSettings(): WorkSettings {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get("work_settings") as { value?: string } | undefined;
    if (!row?.value) {
      return this.saveWorkSettings(DEFAULT_WORK_SETTINGS);
    }

    try {
      return WorkSettingsSchema.parse(JSON.parse(row.value));
    } catch {
      return this.saveWorkSettings(DEFAULT_WORK_SETTINGS);
    }
  }

  saveWorkSettings(settings: WorkSettings): WorkSettings {
    const parsed = WorkSettingsSchema.parse(settings);
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run("work_settings", JSON.stringify(parsed), nowIso());
    return parsed;
  }

  getSetting(key: string, fallback = ""): string {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value ?? fallback;
  }

  saveSetting(key: string, value: string): string {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, nowIso());
    return value;
  }

  private mapTask(row: Record<string, unknown>): Task {
    return {
      id: Number(row.id),
      title: String(row.title),
      durationMinutes: Number(row.duration_minutes),
      deadline: row.deadline ? String(row.deadline) : null,
      earliestStart: row.earliest_start ? String(row.earliest_start) : null,
      nextReviewAt: row.next_review_at ? String(row.next_review_at) : null,
      reviewCadenceDays: row.review_cadence_days === null || row.review_cadence_days === undefined ? null : Number(row.review_cadence_days),
      weeklyTargetMinutes: row.weekly_target_minutes === null || row.weekly_target_minutes === undefined ? null : Number(row.weekly_target_minutes),
      priority: Number(row.priority),
      energy: row.energy as Task["energy"],
      context: row.context ? String(row.context) : null,
      status: row.status as Task["status"],
      scheduledStart: row.scheduled_start ? String(row.scheduled_start) : null,
      scheduledEnd: row.scheduled_end ? String(row.scheduled_end) : null,
      quadrant: row.quadrant ? (String(row.quadrant) as Task["quadrant"]) : null,
      valueScore: Number(row.value_score ?? 3),
      deadlineType: (row.deadline_type ? String(row.deadline_type) : "none") as Task["deadlineType"],
      isProject: Boolean(row.is_project),
      projectId: row.project_id === null || row.project_id === undefined ? null : Number(row.project_id),
      progressNote: row.progress_note ? String(row.progress_note) : null,
      source: row.source ? String(row.source) : null,
      sourceId: row.source_id ? String(row.source_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapSubtask(row: Record<string, unknown>): TaskSubtask {
    return {
      id: Number(row.id),
      taskId: Number(row.task_id),
      title: String(row.title),
      status: String(row.status) as SubtaskStatus,
      followUpAt: row.follow_up_at ? String(row.follow_up_at) : null,
      completionDefinition: row.completion_definition ? String(row.completion_definition) : null,
      note: row.note ? String(row.note) : null,
      sortOrder: Number(row.sort_order ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private nextOpenSubtask(taskId: number): TaskSubtask | null {
    const row = this.db
      .prepare("SELECT * FROM task_subtasks WHERE task_id = ? AND status != 'done' ORDER BY sort_order ASC, id ASC LIMIT 1")
      .get(taskId);
    return row ? this.mapSubtask(row as Record<string, unknown>) : null;
  }

  private touchTask(taskId: number): void {
    this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(nowIso(), taskId);
  }
}

function summarizeSubtasks(subtasks: TaskSubtask[]): TaskSubtaskSummary {
  const done = subtasks.filter((item) => item.status === "done").length;
  const blocked = subtasks.filter((item) => item.status === "blocked").length;
  const waiting = subtasks.filter((item) => item.status === "waiting").length;
  return {
    total: subtasks.length,
    done,
    pending: subtasks.length - done,
    blocked,
    waiting,
    next: subtasks.find((item) => item.status !== "done") || null
  };
}

function aggregateSchedule(plan: Array<{ taskId: number; scheduledStart: string; scheduledEnd: string }>): Array<{ taskId: number; scheduledStart: string; scheduledEnd: string }> {
  const byTask = new Map<number, { taskId: number; scheduledStart: string; scheduledEnd: string }>();
  for (const item of plan) {
    const existing = byTask.get(item.taskId);
    if (!existing) {
      byTask.set(item.taskId, { taskId: item.taskId, scheduledStart: item.scheduledStart, scheduledEnd: item.scheduledEnd });
      continue;
    }
    if (new Date(item.scheduledStart) < new Date(existing.scheduledStart)) {
      existing.scheduledStart = item.scheduledStart;
    }
    if (new Date(item.scheduledEnd) > new Date(existing.scheduledEnd)) {
      existing.scheduledEnd = item.scheduledEnd;
    }
  }
  return [...byTask.values()];
}

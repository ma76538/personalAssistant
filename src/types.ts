import { z } from "zod";

export const EnergySchema = z.enum(["high", "medium", "low"]);
export type Energy = z.infer<typeof EnergySchema>;

export const TaskStatusSchema = z.enum(["pending", "scheduled", "in_progress", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const QuadrantSchema = z.enum(["urgent-important", "urgent-not-important", "not-urgent-important", "not-urgent-not-important"]);
export type Quadrant = z.infer<typeof QuadrantSchema>;

export const IntentSchema = z.enum(["add", "modify", "complete", "cancel", "query_today", "query_week", "replan", "unknown"]);
export type Intent = z.infer<typeof IntentSchema>;

export const ParsedTaskSchema = z.object({
  title: z.string().min(1).optional(),
  durationMinutes: z.number().int().positive().optional(),
  deadline: z.string().datetime().optional(),
  earliestStart: z.string().datetime().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  energy: EnergySchema.optional(),
  context: z.string().optional(),
  target: z.string().optional(),
  newRequirements: z.string().optional()
});
export type ParsedTask = z.infer<typeof ParsedTaskSchema>;

export const ParsedActionSchema = z.object({
  intent: IntentSchema,
  task: ParsedTaskSchema.optional(),
  tasks: z.array(ParsedTaskSchema).optional(),
  clarificationQuestion: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5)
});
export type ParsedAction = z.infer<typeof ParsedActionSchema>;

export type Task = {
  id: number;
  title: string;
  durationMinutes: number;
  deadline: string | null;
  earliestStart: string | null;
  priority: number;
  energy: Energy;
  context: string | null;
  status: TaskStatus;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  quadrant: Quadrant | null;
  source: string | null;
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export const PendingActionSchema = z.object({
  type: z.enum(["add", "modify", "complete", "cancel", "replan"]),
  parsedAction: ParsedActionSchema,
  preview: z.string(),
  schedulePlan: z
    .array(
      z.object({
        taskId: z.number().int().positive(),
        scheduledStart: z.string().datetime(),
        scheduledEnd: z.string().datetime()
      })
    )
    .optional()
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm time");

export const ReminderIntensitySchema = z.enum(["low", "standard", "aggressive"]);
export type ReminderIntensity = z.infer<typeof ReminderIntensitySchema>;

export const ReminderPolicySchema = z.object({
  intensity: ReminderIntensitySchema.default("aggressive"),
  beforeStart: z.object({
    enabled: z.boolean().default(true),
    minutes: z.array(z.number().int().min(1).max(1440)).min(1).default([30, 10])
  }),
  start: z.object({
    enabled: z.boolean().default(true),
    requireResponse: z.boolean().default(true)
  }),
  inProgress: z.object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().int().min(5).max(240).default(30),
    minimumTaskMinutes: z.number().int().min(1).max(480).default(30)
  }),
  end: z.object({
    enabled: z.boolean().default(true)
  }),
  unanswered: z.object({
    enabled: z.boolean().default(true),
    minutes: z.array(z.number().int().min(1).max(1440)).min(1).default([10, 25, 55])
  }),
  quietHours: z.object({
    enabled: z.boolean().default(true),
    start: TimeOfDaySchema.default("23:30"),
    end: TimeOfDaySchema.default("08:00")
  }),
  highPriority: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().int().min(1).max(5).default(4),
    extraBeforeStartMinutes: z.array(z.number().int().min(1).max(1440)).default([60])
  })
});
export type ReminderPolicy = z.infer<typeof ReminderPolicySchema>;

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = ReminderPolicySchema.parse({
  intensity: "aggressive",
  beforeStart: { enabled: true, minutes: [30, 10] },
  start: { enabled: true, requireResponse: true },
  inProgress: { enabled: true, intervalMinutes: 30, minimumTaskMinutes: 30 },
  end: { enabled: true },
  unanswered: { enabled: true, minutes: [10, 25, 55] },
  quietHours: { enabled: true, start: "23:30", end: "08:00" },
  highPriority: { enabled: true, threshold: 4, extraBeforeStartMinutes: [60] }
});

export type ReminderStage = string;

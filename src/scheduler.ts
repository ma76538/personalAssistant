import { addMinutes, setLocalTime, startOfLocalDay } from "./time.js";
import { Task } from "./types.js";

export type ScheduleItem = {
  taskId: number;
  scheduledStart: string;
  scheduledEnd: string;
  segmentIndex: number;
  segmentCount: number;
  conflict?: string;
};

export type BusyBlock = {
  start: string;
  end: string;
  title?: string;
};

type WorkWindow = {
  start: string;
  end: string;
  energies: Array<Task["energy"]>;
};

const WINDOWS: WorkWindow[] = [
  { start: "09:30", end: "12:00", energies: ["high", "medium"] },
  { start: "13:15", end: "14:15", energies: ["low", "medium"] },
  { start: "14:30", end: "17:30", energies: ["high", "medium"] },
  { start: "17:45", end: "19:00", energies: ["low", "medium"] }
];

const BUFFER_MINUTES = 10;
const MAX_SEGMENT_MINUTES = 90;
const MIN_SEGMENT_MINUTES = 25;
const DEFAULT_DAILY_CAPACITY_HOURS = 3;

export function buildSchedule(tasks: Task[], now = new Date(), busyBlocks: BusyBlock[] = [], options: { dailyCapacityHours?: number } = {}): ScheduleItem[] {
  const dailyCapacityMinutes = Math.max(30, Math.round((options.dailyCapacityHours ?? DEFAULT_DAILY_CAPACITY_HOURS) * 60));
  const movable = tasks
    .filter((task) => (task.status === "pending" || task.status === "scheduled") && Boolean(task.deadline) && Boolean(task.quadrant))
    .sort(compareTasks);

  const plan: ScheduleItem[] = [];
  const cursorByWindow = new Map<string, Date>();
  const usedMinutesByDay = new Map<string, number>();
  let day = startOfLocalDay(now);

  for (const task of movable) {
    const segments = splitDuration(task.durationMinutes);
    const taskPlan: ScheduleItem[] = [];

    for (let index = 0; index < segments.length; index += 1) {
      const placement = findPlacement(task, segments[index], cursorByWindow, usedMinutesByDay, dailyCapacityMinutes, day, now, busyBlocks);
      if (!placement) {
        break;
      }
      taskPlan.push({
        ...placement,
        segmentIndex: index + 1,
        segmentCount: segments.length
      });
      day = startOfLocalDay(new Date(placement.scheduledEnd));
    }

    if (taskPlan.length === segments.length) {
      plan.push(...taskPlan);
      continue;
    }
  }

  return plan;
}

function findPlacement(
  task: Task,
  durationMinutes: number,
  cursorByWindow: Map<string, Date>,
  usedMinutesByDay: Map<string, number>,
  dailyCapacityMinutes: number,
  startDay: Date,
  now: Date,
  busyBlocks: BusyBlock[]
): Omit<ScheduleItem, "segmentIndex" | "segmentCount"> | null {
  for (let offset = 0; offset < 21; offset += 1) {
    const day = new Date(startDay.getTime() + offset * 24 * 60 * 60 * 1000);
    const dayKey = day.toDateString();
    if ((usedMinutesByDay.get(dayKey) ?? 0) + durationMinutes > dailyCapacityMinutes) {
      continue;
    }
    const preferred = [
      ...WINDOWS.filter((window) => window.energies.includes(task.energy)),
      ...WINDOWS.filter((window) => !window.energies.includes(task.energy))
    ];

    for (const window of preferred) {
      const key = `${day.toDateString()}-${window.start}-${window.end}`;
      const windowStart = setLocalTime(day, window.start);
      const windowEnd = setLocalTime(day, window.end);
      const earliestStart = task.earliestStart ? new Date(task.earliestStart) : now;
      const cursor = cursorByWindow.get(key) ?? windowStart;
      let start = new Date(Math.max(cursor.getTime(), now.getTime(), earliestStart.getTime()));
      let end = addMinutes(start, durationMinutes);
      const conflict = firstConflict(start, end, busyBlocks);
      if (conflict) {
        start = addMinutes(new Date(conflict.end), BUFFER_MINUTES);
        end = addMinutes(start, durationMinutes);
      }
      const bufferedEnd = addMinutes(end, BUFFER_MINUTES);

      if (end > windowEnd) {
        continue;
      }
      if (task.deadline && end > new Date(task.deadline)) {
        continue;
      }
      if (firstConflict(start, end, busyBlocks)) {
        continue;
      }

      cursorByWindow.set(key, bufferedEnd);
      usedMinutesByDay.set(dayKey, (usedMinutesByDay.get(dayKey) ?? 0) + durationMinutes);
      return { taskId: task.id, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
    }
  }

  return null;
}

function splitDuration(durationMinutes: number): number[] {
  if (durationMinutes <= MAX_SEGMENT_MINUTES) {
    return [durationMinutes];
  }
  const segments: number[] = [];
  let remaining = durationMinutes;
  while (remaining > 0) {
    const next = Math.min(MAX_SEGMENT_MINUTES, remaining);
    if (remaining - next > 0 && remaining - next < MIN_SEGMENT_MINUTES) {
      segments.push(next + remaining - next);
      break;
    }
    segments.push(next);
    remaining -= next;
  }
  return segments;
}

function firstConflict(start: Date, end: Date, busyBlocks: BusyBlock[]): BusyBlock | null {
  const startTime = start.getTime();
  const endTime = end.getTime();
  return (
    busyBlocks
      .map((block) => ({ ...block, startDate: new Date(block.start), endDate: new Date(block.end) }))
      .filter((block) => Number.isFinite(block.startDate.getTime()) && Number.isFinite(block.endDate.getTime()))
      .find((block) => startTime < block.endDate.getTime() && endTime > block.startDate.getTime()) ?? null
  );
}

function compareTasks(a: Task, b: Task): number {
  const aHard = a.deadlineType === "hard";
  const bHard = b.deadlineType === "hard";
  if (aHard !== bHard) {
    return aHard ? -1 : 1;
  }
  if (a.valueScore !== b.valueScore) {
    return b.valueScore - a.valueScore;
  }
  if (a.deadline && b.deadline && a.deadline !== b.deadline) {
    return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
  }
  if (a.deadline && !b.deadline) {
    return -1;
  }
  if (!a.deadline && b.deadline) {
    return 1;
  }
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  const energyRank = { high: 0, medium: 1, low: 2 };
  return energyRank[a.energy] - energyRank[b.energy];
}

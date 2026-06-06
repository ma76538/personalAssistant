import { addMinutes, setLocalTime, startOfLocalDay } from "./time.js";
import { Task } from "./types.js";

export type ScheduleItem = {
  taskId: number;
  scheduledStart: string;
  scheduledEnd: string;
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

export function buildSchedule(tasks: Task[], now = new Date()): ScheduleItem[] {
  const movable = tasks
    .filter((task) => task.status === "pending" || task.status === "scheduled")
    .sort(compareTasks);

  const plan: ScheduleItem[] = [];
  const cursorByWindow = new Map<string, Date>();
  let day = startOfLocalDay(now);

  for (const task of movable) {
    const placement = findPlacement(task, cursorByWindow, day, now);
    if (!placement) {
      day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
      const nextPlacement = findPlacement(task, cursorByWindow, day, now);
      if (nextPlacement) {
        plan.push(nextPlacement);
      }
      continue;
    }
    plan.push(placement);
  }

  return plan;
}

function findPlacement(task: Task, cursorByWindow: Map<string, Date>, startDay: Date, now: Date): ScheduleItem | null {
  for (let offset = 0; offset < 21; offset += 1) {
    const day = new Date(startDay.getTime() + offset * 24 * 60 * 60 * 1000);
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
      const start = new Date(Math.max(cursor.getTime(), now.getTime(), earliestStart.getTime()));
      const end = addMinutes(start, task.durationMinutes);
      const bufferedEnd = addMinutes(end, BUFFER_MINUTES);

      if (end > windowEnd) {
        continue;
      }
      if (task.deadline && end > new Date(task.deadline)) {
        continue;
      }

      cursorByWindow.set(key, bufferedEnd);
      return { taskId: task.id, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
    }
  }

  return null;
}

function compareTasks(a: Task, b: Task): number {
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

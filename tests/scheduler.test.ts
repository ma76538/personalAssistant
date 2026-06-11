import { describe, expect, it } from "vitest";
import { buildSchedule } from "../src/scheduler.js";
import { Task } from "../src/types.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 1,
    title: overrides.title ?? "Task",
    durationMinutes: overrides.durationMinutes ?? 60,
    deadline: overrides.deadline ?? null,
    earliestStart: overrides.earliestStart ?? null,
    priority: overrides.priority ?? 3,
    energy: overrides.energy ?? "medium",
    context: overrides.context ?? null,
    status: overrides.status ?? "pending",
    scheduledStart: overrides.scheduledStart ?? null,
    scheduledEnd: overrides.scheduledEnd ?? null,
    quadrant: overrides.quadrant ?? null,
    source: overrides.source ?? null,
    sourceId: overrides.sourceId ?? null,
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z"
  };
}

describe("buildSchedule", () => {
  it("places high energy work in deep work windows", () => {
    const plan = buildSchedule([task({ id: 1, energy: "high" })], new Date("2026-05-23T01:00:00.000Z"));
    expect(plan).toHaveLength(1);
    const start = new Date(plan[0].scheduledStart);
    expect(start.getHours()).toBeGreaterThanOrEqual(9);
  });

  it("does not schedule tasks that cannot meet their deadline", () => {
    const plan = buildSchedule(
      [task({ id: 1, durationMinutes: 180, deadline: "2026-05-23T02:00:00.000Z" })],
      new Date("2026-05-23T01:30:00.000Z")
    );
    expect(plan).toHaveLength(0);
  });

  it("ignores completed tasks", () => {
    const plan = buildSchedule([task({ id: 1, status: "done" })], new Date("2026-05-23T01:00:00.000Z"));
    expect(plan).toHaveLength(0);
  });
});

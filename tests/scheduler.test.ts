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
    quadrant: overrides.quadrant === undefined ? "urgent-important" : overrides.quadrant,
    source: overrides.source ?? null,
    sourceId: overrides.sourceId ?? null,
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z"
  };
}

describe("buildSchedule", () => {
  it("places high energy work in deep work windows", () => {
    const plan = buildSchedule(
      [task({ id: 1, energy: "high", deadline: "2026-05-24T10:00:00.000Z" })],
      new Date("2026-05-23T01:00:00.000Z")
    );
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

  it("does not schedule tasks without deadlines", () => {
    const plan = buildSchedule([task({ id: 1, deadline: null })], new Date("2026-05-23T01:00:00.000Z"));
    expect(plan).toHaveLength(0);
  });

  it("does not schedule inbox tasks without a quadrant", () => {
    const plan = buildSchedule(
      [task({ id: 1, deadline: "2026-05-24T10:00:00.000Z", quadrant: null })],
      new Date("2026-05-23T01:00:00.000Z")
    );
    expect(plan).toHaveLength(0);
  });

  it("splits long tasks into multiple schedule segments", () => {
    const plan = buildSchedule(
      [task({ id: 1, durationMinutes: 300, deadline: "2026-05-27T10:00:00.000Z" })],
      new Date("2026-05-23T01:00:00.000Z")
    );
    expect(plan).toHaveLength(3);
    expect(plan.map((item) => item.segmentIndex)).toEqual([1, 2, 3]);
    expect(plan.every((item) => item.segmentCount === 3)).toBe(true);
  });

  it("avoids busy calendar blocks", () => {
    const plan = buildSchedule(
      [task({ id: 1, durationMinutes: 60, deadline: "2026-05-24T10:00:00.000Z" })],
      new Date("2026-05-23T01:00:00.000Z"),
      [{ start: "2026-05-23T01:30:00.000Z", end: "2026-05-23T02:40:00.000Z", title: "Meeting" }]
    );
    expect(plan).toHaveLength(1);
    expect(new Date(plan[0].scheduledStart).getTime()).toBeGreaterThanOrEqual(new Date("2026-05-23T02:50:00.000Z").getTime());
  });
});

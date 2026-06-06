import { describe, expect, it } from "vitest";
import { parseFallbackAction } from "../src/fallbackParser.js";

describe("parseFallbackAction", () => {
  it("splits multiline reminders into separate tasks", () => {
    const parsed = parseFallbackAction(`提醒事項
出 Invoice
1. 軟著俾銀葵（軟著）
寫論文
30/06/2026
HKSTP Incubation Program
雄安比賽相關`);

    expect(parsed.intent).toBe("add");
    expect(parsed.tasks?.map((task) => task.title)).toContain("出 Invoice");
    expect(parsed.tasks?.map((task) => task.title)).toContain("寫論文");
    expect(parsed.tasks?.length).toBeGreaterThan(3);
  });

  it("does not treat HKSTP as hours", () => {
    const parsed = parseFallbackAction("HKSTP Incubation Program");
    expect(parsed.task?.durationMinutes).toBeUndefined();
    expect(parsed.task?.title).toBe("HKSTP Incubation Program");
  });

  it("extracts slash dates as deadlines", () => {
    const parsed = parseFallbackAction("寫論文 30/06/2026");
    expect(parsed.task?.deadline).toBeDefined();
    expect(parsed.task?.title).toBe("寫論文");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { MiniMaxClient } from "../src/minimax.js";

describe("MiniMaxClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses JSON even when the model wraps it with thinking and fences", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '<think>分析略</think>\n```json\n{"intent":"add","task":{"title":"完成報價單","durationMinutes":120,"energy":"high"},"confidence":0.92}\n```'
              }
            }
          ]
        })
      }))
    );

    const client = new MiniMaxClient({
      minimaxApiKey: "test-key",
      minimaxBaseUrl: "https://api.minimax.io/v1",
      minimaxModel: "MiniMax-M2.7-highspeed",
      timezone: "Asia/Shanghai"
    });

    const parsed = await client.parseUserMessage({
      text: "明天下午前完成報價單，大概 2 小時，要專心",
      now: new Date("2026-05-23T00:00:00.000Z"),
      activeTasks: []
    });

    expect(parsed.intent).toBe("add");
    expect(parsed.task?.title).toBe("完成報價單");
    expect(parsed.task?.durationMinutes).toBe(120);
  });

  it("accepts an array response and uses the first action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '[{"intent":"add","task":{"title":"整理會議紀錄","durationMinutes":45},"confidence":0.8}]'
              }
            }
          ]
        })
      }))
    );

    const client = new MiniMaxClient({
      minimaxApiKey: "test-key",
      minimaxBaseUrl: "https://api.minimax.io/v1",
      minimaxModel: "MiniMax-M2.7-highspeed",
      timezone: "Asia/Shanghai"
    });

    const parsed = await client.parseUserMessage({
      text: "整理會議紀錄 45 分鐘",
      now: new Date("2026-05-24T00:00:00.000Z"),
      activeTasks: []
    });

    expect(parsed.intent).toBe("add");
    expect(parsed.tasks?.[0]?.title).toBe("整理會議紀錄");
  });

  it("falls back to local parsing when MiniMax does not return JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "好的，我會幫你新增這個任務。"
              }
            }
          ]
        })
      }))
    );

    const client = new MiniMaxClient({
      minimaxApiKey: "test-key",
      minimaxBaseUrl: "https://api.minimax.io/v1",
      minimaxModel: "MiniMax-M2.7-highspeed",
      timezone: "Asia/Shanghai"
    });

    const parsed = await client.parseUserMessage({
      text: "明天整理報價單 大概 2 小時 要專心",
      now: new Date("2026-05-24T00:00:00.000Z"),
      activeTasks: []
    });

    expect(parsed.intent).toBe("add");
    expect(parsed.task?.durationMinutes).toBe(120);
    expect(parsed.task?.energy).toBe("high");
    warn.mockRestore();
  });
});

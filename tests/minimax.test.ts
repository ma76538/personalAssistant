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

  it("parses task triage JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"result":{"valueScore":5,"deadlineType":"hard","recommendedQuadrant":"urgent-important","isProject":true,"estimatedMinutes":90,"nextActionTitle":"整理下一步","clarificationQuestions":[],"reason":"有 PO 且符合方向"}}'
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

    const result = await client.triageTask({
      now: new Date("2026-05-24T00:00:00.000Z"),
      dailyWorkCapacityHours: 3,
      secretaryMvpMode: true,
      task: {
        id: 1,
        title: "電子秘書 MVP",
        durationMinutes: 90,
        deadline: "2026-05-26T10:00:00.000Z",
        earliestStart: null,
        nextReviewAt: null,
        reviewCadenceDays: null,
        weeklyTargetMinutes: null,
        priority: 5,
        energy: "high",
        context: null,
        status: "pending",
        scheduledStart: null,
        scheduledEnd: null,
        quadrant: null,
        valueScore: 5,
        deadlineType: "hard",
        isProject: true,
        projectId: null,
        progressNote: null,
        source: null,
        sourceId: null,
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z"
      }
    });

    expect(result.valueScore).toBe(5);
    expect(result.recommendedQuadrant).toBe("urgent-important");
  });

  it("parses next action JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"action":{"title":"整理電子秘書下一步","durationMinutes":60,"deadline":null,"earliestStart":null,"reason":"先做可執行下一步"}}'
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

    const action = await client.suggestNextAction({
      now: new Date("2026-05-24T00:00:00.000Z"),
      progressNote: "同步已完成",
      project: {
        id: 1,
        title: "電子秘書 MVP",
        durationMinutes: 600,
        deadline: null,
        earliestStart: null,
        nextReviewAt: null,
        reviewCadenceDays: null,
        weeklyTargetMinutes: null,
        priority: 5,
        energy: "high",
        context: null,
        status: "pending",
        scheduledStart: null,
        scheduledEnd: null,
        quadrant: "urgent-important",
        valueScore: 5,
        deadlineType: "none",
        isProject: true,
        projectId: null,
        progressNote: null,
        source: null,
        sourceId: null,
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z"
      }
    });

    expect(action.title).toBe("整理電子秘書下一步");
    expect(action.durationMinutes).toBe(60);
  });
});

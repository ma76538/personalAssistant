import { z } from "zod";
import { AppConfig } from "./config.js";
import { parseFallbackAction } from "./fallbackParser.js";
import { ParsedAction, ParsedActionSchema, Task } from "./types.js";

type MiniMaxMessage = {
  role: "system" | "user" | "assistant";
  name?: string;
  content: string;
};

const MiniMaxResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string()
      })
    })
  )
});

const ParsedActionResultSchema = z.preprocess((value) => {
  if (Array.isArray(value)) {
    const tasks = value
      .map((item) => (typeof item === "object" && item !== null && "task" in item ? (item as { task?: unknown }).task : item))
      .filter(Boolean);
    return tasks.length > 0
      ? { intent: "add", tasks, confidence: 0.75 }
      : { intent: "unknown", confidence: 0, clarificationQuestion: "我讀到多個動作，但未能抽取任務。請再傳一次。" };
  }
  return value;
}, ParsedActionSchema);

export class MiniMaxClient {
  constructor(private readonly config: Pick<AppConfig, "minimaxApiKey" | "minimaxBaseUrl" | "minimaxModel" | "timezone">) {}

  async parseUserMessage(input: { text: string; now: Date; activeTasks: Task[] }): Promise<ParsedAction> {
    const system = [
      "你是個人任務助理的語意解析器。只輸出單一 JSON object，不要 Markdown，不要解釋。",
      "把使用者中文訊息解析成 intent 與 task 欄位。",
      "如果使用者一次提供多個任務，輸出 {\"intent\":\"add\",\"tasks\":[...],\"confidence\":0.9}。",
      "如果只有一個任務，輸出 {\"intent\":\"add\",\"task\":{...},\"confidence\":0.9}。",
      "intent 必須是 add, modify, complete, cancel, query_today, query_week, replan, unknown 之一。",
      "所有日期時間必須輸出 ISO 8601 UTC 字串；若日期不明確，提出 clarificationQuestion。",
      "priority 是 1-5，5 最高。energy 是 high, medium, low。",
      "durationMinutes 缺失時可省略，不要亂猜。"
    ].join("\n");
    const activeTaskSummary = input.activeTasks.map((task) => ({
      id: task.id,
      title: task.title,
      deadline: task.deadline,
      scheduledStart: task.scheduledStart,
      status: task.status
    }));
    const user = JSON.stringify({
      now: input.now.toISOString(),
      timezone: this.config.timezone,
      text: input.text,
      activeTasks: activeTaskSummary,
      schema: {
        intent: "add|modify|complete|cancel|query_today|query_week|replan|unknown",
        task: {
          title: "string optional",
          durationMinutes: "positive integer optional",
          deadline: "ISO datetime optional",
          earliestStart: "ISO datetime optional",
          priority: "1-5 optional",
          energy: "high|medium|low optional",
          context: "string optional",
          target: "task id or keyword optional",
          newRequirements: "string optional"
        },
        tasks: "array of task objects optional, required when input contains multiple reminders/tasks",
        clarificationQuestion: "string optional",
        confidence: "0..1"
      }
    });

    try {
      return await this.requestJson([this.message("system", system), this.message("user", user)], ParsedActionResultSchema);
    } catch (error) {
      console.warn("MiniMax JSON parsing failed, using local fallback parser", error);
      return parseFallbackAction(input.text);
    }
  }

  async summarizeSchedule(input: { userText: string; preview: string }): Promise<string> {
    const system = "你是繁體中文個人助理。請把排程異動用簡短、清楚、可確認的 Telegram 訊息說明。不要使用 Markdown 表格。";
    const content = JSON.stringify(input);
    const response = await this.request([this.message("system", system), this.message("user", content)]);
    return stripThinking(response).trim() || input.preview;
  }

  private async requestJson<T>(messages: MiniMaxMessage[], schema: z.ZodType<T>): Promise<T> {
    const first = await this.request(messages);
    const parsed = parseJson(first);
    if (parsed.success) {
      const result = schema.safeParse(parsed.value);
      if (result.success) {
        return result.data;
      }
    }

    const retryPrompt = [
      ...messages,
      this.message("assistant", first),
      this.message("user", "上一則輸出不是符合 schema 的純 JSON。請只重新輸出合法 JSON。")
    ];
    const second = await this.request(retryPrompt);
    const retryParsed = parseJson(second);
    if (!retryParsed.success) {
      throw new Error("MiniMax did not return JSON");
    }
    const retryResult = schema.safeParse(retryParsed.value);
    if (!retryResult.success) {
      throw new Error(`MiniMax returned invalid JSON shape: ${retryResult.error.message}`);
    }
    return retryResult.data;
  }

  private async request(messages: MiniMaxMessage[]): Promise<string> {
    const response = await fetch(`${this.config.minimaxBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.minimaxApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.minimaxModel,
        messages,
        temperature: 0.2,
        max_completion_tokens: 1200
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`MiniMax API error ${response.status}: ${body}`);
    }

    const payload = MiniMaxResponseSchema.parse(await response.json());
    return payload.choices[0]?.message.content ?? "";
  }

  private message(role: MiniMaxMessage["role"], content: string): MiniMaxMessage {
    return { role, name: role === "user" ? "User" : "MiniMax AI", content };
  }
}

function parseJson(raw: string): { success: true; value: unknown } | { success: false } {
  const cleaned = stripThinking(raw).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return { success: true, value: JSON.parse(cleaned) };
  } catch {
    const objectStart = cleaned.indexOf("{");
    const arrayStart = cleaned.indexOf("[");
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    const start = starts.length ? Math.min(...starts) : -1;
    const end = start === arrayStart && (objectStart < 0 || arrayStart < objectStart) ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return { success: true, value: JSON.parse(cleaned.slice(start, end + 1)) };
      } catch {
        return { success: false };
      }
    }
    return { success: false };
  }
}

function stripThinking(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

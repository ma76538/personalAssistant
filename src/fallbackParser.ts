import { ParsedAction, ParsedTask } from "./types.js";

export function parseFallbackAction(text: string): ParsedAction {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();

  if (/(今天|今日).*(安排|任務|做咩|做什麼|schedule)|\/today/.test(normalized)) {
    return { intent: "query_today", confidence: 0.7 };
  }
  if (/(本週|這週|今週|week).*(安排|任務|schedule)|\/week/.test(normalized)) {
    return { intent: "query_week", confidence: 0.7 };
  }
  if (/(重排|重新安排|replan|reschedule)/i.test(normalized)) {
    return { intent: "replan", confidence: 0.7 };
  }
  if (/^(完成|做完|已完成|done)\s*/i.test(normalized)) {
    return {
      intent: "complete",
      task: { target: normalized.replace(/^(完成|做完|已完成|done)\s*/i, "").trim() },
      confidence: 0.65
    };
  }
  if (/^(取消|cancel)\s*/i.test(normalized)) {
    return {
      intent: "cancel",
      task: { target: normalized.replace(/^(取消|cancel)\s*/i, "").trim() },
      confidence: 0.65
    };
  }
  if (/^(修改|改|move)\s*/i.test(normalized)) {
    return {
      intent: "modify",
      task: { target: normalized.replace(/^(修改|改|move)\s*/i, "").trim(), newRequirements: normalized },
      confidence: 0.55
    };
  }

  const parsedTasks = parseTaskLines(normalized);
  if (parsedTasks.length > 1) {
    return {
      intent: "add",
      tasks: parsedTasks,
      confidence: 0.7
    };
  }

  return {
    intent: "add",
    task: parseTaskLine(normalized),
    confidence: lower.includes("todo") || /要|需要|完成|處理|整理|準備/.test(normalized) ? 0.6 : 0.45
  };
}

function parseTaskLines(text: string): ParsedTask[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeListLine(line))
    .filter((line) => line && !isHeadingLine(line));

  return lines.map(parseTaskLine).filter((task) => task.title && task.title.length >= 2);
}

function parseTaskLine(text: string): ParsedTask {
  return {
    title: cleanupTitle(text),
    durationMinutes: parseDurationMinutes(text),
    deadline: parseDate(text),
    priority: parsePriority(text),
    energy: parseEnergy(text),
    context: parseContext(text)
  };
}

function normalizeListLine(line: string): string {
  return line.replace(/^[\s•\-*○◦▪▫☐☑✓]+/, "").replace(/^\d+[.)、]\s*/, "").trim();
}

function isHeadingLine(line: string): boolean {
  return /^(提醒事項|所有任務|任務排程確認|待安排|5月|6月|7月|8月|9月|10月|11月|12月|📋|🎯)$/i.test(line.trim());
}

function cleanupTitle(text: string): string {
  return text
    .replace(/大概|約|大約/g, "")
    .replace(/\d+(\.\d+)?\s*(小時|個鐘|hours?|hrs?|分鐘|分|min)/gi, "")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, "")
    .replace(/\b(?:today|tomorrow)\b,?\s*\d{1,2}:\d{2}/gi, "")
    .replace(/要專心|高能量|低能量|中能量|低強度|行政/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || text.slice(0, 80);
}

function parseDurationMinutes(text: string): number | undefined {
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(小時|個鐘|hours?|hrs?)(?![a-z])/i);
  if (hourMatch) {
    return Math.round(Number(hourMatch[1]) * 60);
  }
  const minuteMatch = text.match(/(\d+)\s*(分鐘|分|min)(?![a-z])/i);
  if (minuteMatch) {
    return Number(minuteMatch[1]);
  }
  return undefined;
}

function parsePriority(text: string): number | undefined {
  if (/緊急|很急|最高|重要/.test(text)) {
    return 5;
  }
  if (/不急|低優先/.test(text)) {
    return 2;
  }
  return undefined;
}

function parseEnergy(text: string): "high" | "medium" | "low" | undefined {
  if (/專心|深度|高能量|focus|deep/i.test(text)) {
    return "high";
  }
  if (/行政|簡單|低能量|低強度|碎片/i.test(text)) {
    return "low";
  }
  if (/中能量|普通/i.test(text)) {
    return "medium";
  }
  return undefined;
}

function parseContext(text: string): string | undefined {
  const contextMatch = text.match(/(?:情境|context|類型)[:：]\s*(.+)$/i);
  return contextMatch?.[1]?.trim();
}

function parseDate(text: string): string | undefined {
  const match = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (!match) {
    return undefined;
  }

  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const rawYear = match[3] ? Number(match[3]) : new Date().getFullYear();
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const date = new Date(year, month, day, 18, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

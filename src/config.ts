import "dotenv/config";
import path from "node:path";

export type AppConfig = {
  telegramBotToken: string;
  allowedUserId: number;
  minimaxApiKey: string;
  minimaxModel: string;
  minimaxBaseUrl: string;
  databasePath: string;
  timezone: string;
  dashboardPort: number;
  dailyBriefTime: string;
  appleReminderSyncEnabled: boolean;
  appleReminderSyncIntervalMinutes: number;
  appleReminderSyncListName: string;
  calendarAccountEmail: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const databasePath = process.env.DATABASE_PATH || "./data/assistant.sqlite";
  const syncInterval = Number(process.env.APPLE_REMINDER_SYNC_INTERVAL_MINUTES || 5);

  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUserId: Number(required("TELEGRAM_ALLOWED_USER_ID")),
    minimaxApiKey: required("MINIMAX_API_KEY"),
    minimaxModel: process.env.MINIMAX_MODEL || "MiniMax-M2.7-highspeed",
    minimaxBaseUrl: process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1",
    databasePath: path.resolve(databasePath),
    timezone: process.env.TIMEZONE || "Asia/Macau",
    dashboardPort: Number(process.env.DASHBOARD_PORT || 8787),
    dailyBriefTime: process.env.DAILY_BRIEF_TIME || "08:30",
    appleReminderSyncEnabled: process.env.APPLE_REMINDER_SYNC_ENABLED !== "false",
    appleReminderSyncIntervalMinutes: Number.isFinite(syncInterval) && syncInterval > 0 ? syncInterval : 5,
    appleReminderSyncListName: process.env.APPLE_REMINDER_SYNC_LIST_NAME || "全部",
    calendarAccountEmail: process.env.CALENDAR_ACCOUNT_EMAIL || "kevin@region.mo"
  };
}

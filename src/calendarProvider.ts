import crypto from "node:crypto";
import { AssistantRepository } from "./db.js";
import {
  buildGoogleCalendarAuthUrl,
  exchangeGoogleAuthCode,
  GoogleCalendarConfig,
  hasGoogleAuthorization,
  hasGoogleCredentials,
  listGoogleCalendarEvents,
  ensureGoogleAccessToken
} from "./googleCalendar.js";

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendarTitle: string;
  sourceTitle: string;
};

export type CalendarResult = {
  accountEmail: string;
  provider: "google-calendar";
  connected: boolean;
  events: CalendarEvent[];
  oauthStatus: string;
  matchMode?: string;
  matchedCalendars?: string[];
  error?: string;
};

export type CalendarSettingsResponse = {
  accountEmail: string;
  provider: "google-calendar";
  oauthStatus: string;
  googleClientId: string;
  hasGoogleClientSecret: boolean;
  hasRefreshToken: boolean;
  redirectUri: string;
  note: string;
};

export type CalendarSettingsInput = {
  accountEmail: string;
  googleClientId?: string;
  googleClientSecret?: string;
};

const DEFAULT_CALENDAR_ACCOUNT_EMAIL = process.env.CALENDAR_ACCOUNT_EMAIL || "kevin@region.mo";

export function getCalendarAccountEmail(repo: AssistantRepository): string {
  return repo.getSetting("calendar_account_email", DEFAULT_CALENDAR_ACCOUNT_EMAIL);
}

export function getGoogleCalendarConfig(repo: AssistantRepository): GoogleCalendarConfig {
  return {
    accountEmail: getCalendarAccountEmail(repo),
    clientId: repo.getSetting("google_calendar_client_id"),
    clientSecret: repo.getSetting("google_calendar_client_secret"),
    refreshToken: repo.getSetting("google_calendar_refresh_token"),
    accessToken: repo.getSetting("google_calendar_access_token"),
    tokenExpiry: repo.getSetting("google_calendar_token_expiry")
  };
}

export function saveCalendarSettings(repo: AssistantRepository, input: CalendarSettingsInput): CalendarSettingsResponse {
  repo.saveSetting("calendar_account_email", input.accountEmail);
  if (input.googleClientId !== undefined) {
    repo.saveSetting("google_calendar_client_id", input.googleClientId.trim());
  }
  if (input.googleClientSecret?.trim()) {
    repo.saveSetting("google_calendar_client_secret", input.googleClientSecret.trim());
  }
  return calendarSettings(repo, "");
}

export function calendarSettings(repo: AssistantRepository, origin: string): CalendarSettingsResponse {
  const config = getGoogleCalendarConfig(repo);
  return {
    accountEmail: config.accountEmail,
    provider: "google-calendar",
    oauthStatus: googleOAuthStatus(config),
    googleClientId: config.clientId,
    hasGoogleClientSecret: Boolean(config.clientSecret),
    hasRefreshToken: Boolean(config.refreshToken),
    redirectUri: origin ? googleRedirectUri(origin) : "",
    note: calendarSettingsNote(config)
  };
}

export function createGoogleCalendarAuthUrl(repo: AssistantRepository, origin: string): string {
  const state = crypto.randomBytes(18).toString("hex");
  repo.saveSetting("google_calendar_oauth_state", state);
  return buildGoogleCalendarAuthUrl(getGoogleCalendarConfig(repo), googleRedirectUri(origin), state);
}

export async function completeGoogleCalendarOAuth(repo: AssistantRepository, input: { code: string; state: string; origin: string }): Promise<void> {
  const expectedState = repo.getSetting("google_calendar_oauth_state");
  if (!expectedState || expectedState !== input.state) {
    throw new Error("Google Calendar OAuth state 不一致，請重新連接。");
  }
  const token = await exchangeGoogleAuthCode(getGoogleCalendarConfig(repo), input.code, googleRedirectUri(input.origin));
  repo.saveSetting("google_calendar_refresh_token", token.refreshToken);
  repo.saveSetting("google_calendar_access_token", token.accessToken);
  repo.saveSetting("google_calendar_token_expiry", token.tokenExpiry);
  repo.saveSetting("google_calendar_oauth_state", "");
}

export async function listCalendarEvents(repo: AssistantRepository, startIso: string, endIso: string): Promise<CalendarResult> {
  const config = getGoogleCalendarConfig(repo);
  if (hasGoogleAuthorization(config)) {
    try {
      const token = await ensureGoogleAccessToken(config);
      if (token.accessToken !== config.accessToken || token.tokenExpiry !== config.tokenExpiry) {
        repo.saveSetting("google_calendar_access_token", token.accessToken);
        repo.saveSetting("google_calendar_token_expiry", token.tokenExpiry);
      }
      const events = await listGoogleCalendarEvents(config, startIso, endIso, token.accessToken);
      return {
        accountEmail: config.accountEmail,
        provider: "google-calendar",
        connected: true,
        oauthStatus: "connected",
        events
      };
    } catch (error) {
      return {
        accountEmail: config.accountEmail,
        provider: "google-calendar",
        connected: false,
        oauthStatus: "google_read_failed",
        events: [],
        error: error instanceof Error ? error.message : "Google Calendar 讀取失敗。"
      };
    }
  }

  return {
    accountEmail: config.accountEmail,
    provider: "google-calendar",
    connected: false,
    oauthStatus: googleOAuthStatus(config),
    events: [],
    error: googleOAuthStatus(config) === "google_credentials_missing" ? "請先設定 Google OAuth Client ID / Secret。" : "請先連接 Google Calendar。"
  };
}

export function googleRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, "")}/oauth/google-calendar/callback`;
}

function googleOAuthStatus(config: GoogleCalendarConfig): string {
  if (!hasGoogleCredentials(config)) {
    return "google_credentials_missing";
  }
  if (!config.refreshToken) {
    return "google_authorization_required";
  }
  return "connected";
}

function calendarSettingsNote(config: GoogleCalendarConfig): string {
  if (!hasGoogleCredentials(config)) {
    return "請在 Google Cloud 建立 OAuth Client，將 Redirect URI 設為本頁顯示的 callback URL，然後在這裡儲存 Client ID / Secret。";
  }
  if (!config.refreshToken) {
    return "OAuth credentials 已儲存。按「連接 Google Calendar」後，用 kevin@region.mo 授權 read-only Calendar。";
  }
  return "Google Calendar 已授權。主頁月曆與甘特圖會直接使用 Google Calendar，不會讀取 macOS Calendar。";
}

export type GoogleCalendarConfig = {
  accountEmail: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  tokenExpiry: string;
};

export type GoogleCalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendarTitle: string;
  sourceTitle: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GoogleEvent = {
  id?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
};

type GoogleEventResponse = {
  items?: GoogleEvent[];
  summary?: string;
  error?: { message?: string };
};

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function hasGoogleCredentials(config: GoogleCalendarConfig): boolean {
  return Boolean(config.clientId && config.clientSecret);
}

export function hasGoogleAuthorization(config: GoogleCalendarConfig): boolean {
  return hasGoogleCredentials(config) && Boolean(config.refreshToken);
}

export function buildGoogleCalendarAuthUrl(config: GoogleCalendarConfig, redirectUri: string, state: string): string {
  if (!hasGoogleCredentials(config)) {
    throw new Error("請先儲存 Google OAuth Client ID / Client Secret。");
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleAuthCode(config: GoogleCalendarConfig, code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; tokenExpiry: string }> {
  if (!hasGoogleCredentials(config)) {
    throw new Error("Google OAuth credentials are missing.");
  }
  const token = await postGoogleToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });
  if (!token.access_token) {
    throw new Error(token.error_description || token.error || "Google did not return an access token.");
  }
  const refreshToken = token.refresh_token || config.refreshToken;
  if (!refreshToken) {
    throw new Error("Google did not return a refresh token. Reconnect with consent prompt.");
  }
  return {
    accessToken: token.access_token,
    refreshToken,
    tokenExpiry: expiryFromNow(token.expires_in)
  };
}

export async function ensureGoogleAccessToken(config: GoogleCalendarConfig): Promise<{ accessToken: string; tokenExpiry: string }> {
  if (config.accessToken && config.tokenExpiry && new Date(config.tokenExpiry).getTime() > Date.now() + 60_000) {
    return { accessToken: config.accessToken, tokenExpiry: config.tokenExpiry };
  }
  if (!hasGoogleAuthorization(config)) {
    throw new Error("Google Calendar 尚未授權。");
  }
  const token = await postGoogleToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token"
  });
  if (!token.access_token) {
    throw new Error(token.error_description || token.error || "Google access token refresh failed.");
  }
  return {
    accessToken: token.access_token,
    tokenExpiry: expiryFromNow(token.expires_in)
  };
}

export async function listGoogleCalendarEvents(
  config: GoogleCalendarConfig,
  startIso: string,
  endIso: string,
  accessToken: string
): Promise<GoogleCalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250"
  });
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payload = (await response.json()) as GoogleEventResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message || `Google Calendar API failed with ${response.status}`);
  }
  const calendarTitle = payload.summary || config.accountEmail;
  return (payload.items || [])
    .map((event) => normalizeGoogleEvent(event, calendarTitle))
    .filter((event): event is GoogleCalendarEvent => Boolean(event));
}

async function postGoogleToken(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Google token endpoint failed with ${response.status}`);
  }
  return payload;
}

function normalizeGoogleEvent(event: GoogleEvent, calendarTitle: string): GoogleCalendarEvent | null {
  const allDay = Boolean(event.start?.date && event.end?.date);
  const start = event.start?.dateTime || dateOnlyToIso(event.start?.date);
  const end = event.end?.dateTime || dateOnlyToIso(event.end?.date);
  if (!event.id || !start || !end) {
    return null;
  }
  return {
    id: event.id,
    title: event.summary || "(No title)",
    start,
    end,
    allDay,
    calendarTitle,
    sourceTitle: "Google Calendar"
  };
}

function dateOnlyToIso(value?: string): string | null {
  return value ? `${value}T00:00:00.000Z` : null;
}

function expiryFromNow(expiresIn?: number): string {
  const seconds = Number.isFinite(expiresIn) && expiresIn ? expiresIn : 3600;
  return new Date(Date.now() + Math.max(60, seconds - 60) * 1000).toISOString();
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantRepository } from "../src/db.js";
import { completeGoogleCalendarOAuth, createGoogleCalendarAuthUrl, listCalendarEvents } from "../src/calendarProvider.js";

function tempRepo(): AssistantRepository {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-calendar-"));
  return new AssistantRepository(path.join(dir, "test.sqlite"));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Calendar provider", () => {
  it("stores refresh token after OAuth callback", async () => {
    const repo = tempRepo();
    repo.saveSetting("calendar_account_email", "kevin@region.mo");
    repo.saveSetting("google_calendar_client_id", "client-id");
    repo.saveSetting("google_calendar_client_secret", "client-secret");
    const authUrl = createGoogleCalendarAuthUrl(repo, "http://127.0.0.1:8787");
    const state = new URL(authUrl).searchParams.get("state");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600
        })
      }))
    );

    await completeGoogleCalendarOAuth(repo, { code: "code", state: state!, origin: "http://127.0.0.1:8787" });

    expect(repo.getSetting("google_calendar_refresh_token")).toBe("refresh-token");
    expect(repo.getSetting("google_calendar_access_token")).toBe("access-token");
    expect(repo.getSetting("google_calendar_token_expiry")).not.toBe("");
    repo.close();
  });

  it("reads events from every selected Google calendar", async () => {
    const repo = tempRepo();
    repo.saveSetting("calendar_account_email", "kevin@region.mo");
    repo.saveSetting("google_calendar_client_id", "client-id");
    repo.saveSetting("google_calendar_client_secret", "client-secret");
    repo.saveSetting("google_calendar_refresh_token", "refresh-token");
    repo.saveSetting("google_calendar_access_token", "access-token");
    repo.saveSetting("google_calendar_token_expiry", new Date(Date.now() + 3_600_000).toISOString());

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        calls.push(href);
        if (href.includes("/users/me/calendarList")) {
          return {
            ok: true,
            json: async () => ({
              items: [
                { id: "primary", summary: "kevin@region.mo", primary: true, selected: true },
                { id: "company@example.com", summary: "公司日曆", selected: true },
                { id: "hidden@example.com", summary: "隱藏日曆", selected: false }
              ]
            })
          };
        }
        if (href.includes("/calendars/primary/events")) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: "event-1", summary: "例會", start: { dateTime: "2026-06-22T10:00:00+08:00" }, end: { dateTime: "2026-06-22T11:00:00+08:00" } }]
            })
          };
        }
        if (href.includes("/calendars/company%40example.com/events")) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: "event-2", summary: "公司網絡費、電話費", start: { date: "2026-06-13" }, end: { date: "2026-06-14" } }]
            })
          };
        }
        return { ok: false, json: async () => ({ error: { message: "unexpected url" } }) };
      })
    );

    const result = await listCalendarEvents(repo, "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");

    expect(result.connected).toBe(true);
    expect(result.matchedCalendars).toEqual(["kevin@region.mo", "公司日曆"]);
    expect(result.events.map((event) => event.title)).toEqual(["公司網絡費、電話費", "例會"]);
    expect(calls.some((call) => call.includes("/users/me/calendarList"))).toBe(true);
    expect(calls.some((call) => call.includes("/calendars/company%40example.com/events"))).toBe(true);
    repo.close();
  });
});

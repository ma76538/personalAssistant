import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantRepository } from "../src/db.js";
import { completeGoogleCalendarOAuth, createGoogleCalendarAuthUrl } from "../src/calendarProvider.js";

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
});

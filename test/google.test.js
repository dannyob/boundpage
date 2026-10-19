import { describe, it, expect } from "vitest";
import { ORIGIN, G_ALICE, G_BOB, call, cookieValue, share, login, open } from "./helpers.js";

describe("Google sign-in", () => {
  it("is offered alongside GitHub", async () => {
    const { id, cap } = await share();
    const { methods } = await (await open(id, cap)).json();
    expect(methods.map((m) => m.id)).toEqual(["github", "google"]);
  });

  it("redirects to Google asking for openid, email and profile", async () => {
    const res = await call("/auth/google/start?return=%2Fr%2Fabc");
    const loc = new URL(res.headers.get("location"));
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("client_id")).toBe("test-google-id");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(loc.searchParams.get("state")).toBeTruthy();
  });

  it("latches a TOFU invite to the Google account", async () => {
    const { id, cap } = await share();
    expect((await open(id, cap, await login(G_ALICE, { provider: "google" }))).status).toBe(200);
    expect((await open(id, cap, await login(G_BOB, { provider: "google" }))).status).toBe(403);
  });

  it("lets the named person claim a targeted invite with Google", async () => {
    const { id, cap } = await share({ expectEmail: "alice@example.com" });
    expect((await open(id, cap, await login(G_BOB, { provider: "google" }))).status).toBe(403);
    expect((await open(id, cap, await login(G_ALICE, { provider: "google" }))).status).toBe(200);
  });

  it("does not trust an unverified Google email for a targeted invite", async () => {
    const { id, cap } = await share({ expectEmail: "alice@example.com" });
    const unverified = { google: { sub: "g-333", email: "alice@example.com", email_verified: false } };
    expect((await open(id, cap, await login(unverified, { provider: "google" }))).status).toBe(403);
  });

  it("rejects an ID token issued for a different client", async () => {
    const otherApp = { google: { sub: "g-444", email: "alice@example.com", email_verified: true, aud: "someone-else" } };
    expect(await login(otherApp, { provider: "google" })).toBeUndefined();
  });

  it("rejects a callback with a bad code", async () => {
    const start = await call("/auth/google/start", {}, G_ALICE);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cb = await call(`/auth/google/callback?code=bad-code&state=${state}`, {
      headers: { cookie: `bp_oauth=${cookieValue(start, "bp_oauth")}` },
    }, G_ALICE);
    expect(cb.status).toBe(400);
    expect(cookieValue(cb, "bp_session")).toBeUndefined();
  });
});

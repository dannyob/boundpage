import { describe, it, expect } from "vitest";
import { ORIGIN, ADMIN, ALICE, BOB, call, cookieValue, share, login, open } from "./helpers.js";

describe("admin API", () => {
  it("refuses requests without the admin token", async () => {
    const res = await call("/admin/resources", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("returns a capability URL with the secret in the fragment", async () => {
    const { id, url } = await share();
    expect(url).toMatch(new RegExp(`^${ORIGIN}/r/${id}#cap=[A-Za-z0-9_-]{43}$`));
  });
});

describe("bootstrap page", () => {
  it("serves a page that contains no content and sends no referrer", async () => {
    const { id } = await share();
    const res = await call(`/r/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).not.toContain("the secret page");
  });

  it("answers HEAD requests for the page", async () => {
    const { id } = await share();
    const res = await call(`/r/${id}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("opening a capability", () => {
  it("asks an anonymous visitor to sign in, returning to the page", async () => {
    const { id, cap } = await share();
    const res = await open(id, cap);
    expect(res.status).toBe(401);
    const { methods } = await res.json();
    expect(methods).toContainEqual({ id: "github", name: "GitHub", url: `/auth/github/start?return=${encodeURIComponent(`/r/${id}`)}` });
  });

  it("does not recognise a wrong capability", async () => {
    const { id } = await share();
    expect((await open(id, "wrong")).status).toBe(404);
  });

  it("does not recognise a malformed resource id", async () => {
    expect((await open("not-a-do-id", "wrong")).status).toBe(404);
  });

  it("gives the content to the first person, then refuses everyone else", async () => {
    const { id, cap } = await share();

    const alice = await login(ALICE);
    const first = await open(id, cap, alice);
    expect(first.status).toBe(200);
    expect((await first.json()).html).toBe("<p>the secret page</p>");

    const bob = await login(BOB);
    const second = await open(id, cap, bob);
    expect(second.status).toBe(403);
    expect((await second.json()).signedInAs).toBe("bob");
  });

  it("lets only the named person claim a targeted invite", async () => {
    const { id, cap } = await share({ expectEmail: "alice@example.com" });
    expect((await open(id, cap, await login(BOB))).status).toBe(403);
    expect((await open(id, cap, await login(ALICE))).status).toBe(200);
  });

  it("ignores unverified GitHub emails when matching a targeted invite", async () => {
    const { id, cap } = await share({ expectEmail: "alice@example.com" });
    const mallory = { id: 3, login: "mallory", emails: [{ email: "alice@example.com", verified: false, primary: false }] };
    expect((await open(id, cap, await login(mallory))).status).toBe(403);
  });

  it("refuses a forged session cookie", async () => {
    const { id, cap } = await share();
    expect((await open(id, cap, "eyJzdWIiOiJnaXRodWI6MSJ9.forged")).status).toBe(401);
  });
});

describe("GitHub login", () => {
  it("redirects to GitHub with a state that matches the state cookie", async () => {
    const res = await call("/auth/github/start?return=%2Fr%2Fabc");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location"));
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(cookieValue(res, "bp_oauth")).toBeTruthy();
  });

  it("returns to the requested page after login", async () => {
    const start = await call("/auth/github/start?return=%2Fr%2Fabc");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cb = await call(`/auth/github/callback?code=good-code&state=${state}`, {
      headers: { cookie: `bp_oauth=${cookieValue(start, "bp_oauth")}` },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/r/abc");
    expect(cookieValue(cb, "bp_session")).toBeTruthy();
  });

  it("will not redirect off-site after login", async () => {
    const start = await call(`/auth/github/start?return=${encodeURIComponent("//evil.example/")}`);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cb = await call(`/auth/github/callback?code=good-code&state=${state}`, {
      headers: { cookie: `bp_oauth=${cookieValue(start, "bp_oauth")}` },
    });
    expect(cb.headers.get("location")).toBe("/");
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const start = await call("/auth/github/start");
    const cb = await call("/auth/github/callback?code=good-code&state=someone-elses", {
      headers: { cookie: `bp_oauth=${cookieValue(start, "bp_oauth")}` },
    });
    expect(cb.status).toBe(400);
    expect(cookieValue(cb, "bp_session")).toBeUndefined();
  });

  it("rejects a callback with a bad code", async () => {
    const start = await call("/auth/github/start");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cb = await call(`/auth/github/callback?code=bad-code&state=${state}`, {
      headers: { cookie: `bp_oauth=${cookieValue(start, "bp_oauth")}` },
    });
    expect(cb.status).toBe(400);
    expect(cookieValue(cb, "bp_session")).toBeUndefined();
  });

  it("does not know an unconfigured provider", async () => {
    expect((await call("/auth/myspace/start")).status).toBe(404);
  });

  it("clears the session on logout", async () => {
    const res = await call("/auth/logout", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().join()).toMatch(/bp_session=;.*Max-Age=0/);
  });
});

describe("privacy page", () => {
  it("is served as HTML and names what is stored", async () => {
    const res = await call("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("Privacy");
    expect(text).toContain("share@libertyh.dev");
  });

  it("names Liberty Hall as the operator and links the services it uses", async () => {
    const text = await (await call("/privacy")).text();
    expect(text).toContain("Liberty Hall");
    expect(text).not.toContain("Danny O'Brien");
    expect(text).toContain('href="mailto:share@libertyh.dev"');
    expect(text).toContain('href="https://www.cloudflare.com/');
    expect(text).toContain('href="https://purelymail.com/');
  });
});
